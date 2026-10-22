/**
 * Build a native addon for a package dir other worktrees share, without touching what they load.
 *
 * Under pnpm's global virtual store the package dir is one store slot for every worktree, so an
 * in-place node-gyp rebuild swaps the binary out from under running processes. Instead the
 * source is compiled in a private scratch copy, the outputs are validated in a fresh process,
 * and they are published as the immutable `build/<entry>` from native-build-entry.cjs. A usable
 * entry is reused as-is and never rebuilt, which is also why a forced rebuild cannot displace it.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { disableMsbuildFileTrackingOnWindows } from './msbuild-file-tracking.mjs'
import { stageNodeAddonApi } from './orcad-prebuild-node-gyp.mjs'
import { describeProcessFailure } from './process-failure-message.mjs'
import { publishSharedTree, sharedTreeStagingPath } from './shared-tree-publish.mjs'
import { nativeBuildEntryDir } from './native-build-entry.cjs'
import {
  ensureWindowsProcessTreeCommandLinePatch,
  inspectWindowsProcessTreeAddon,
  nodeGypRebuildInvocation,
  nodeGypRebuildTimeoutMs,
  stageWindowsProcessTreeNodeAddonApiHeaders
} from './windows-process-tree-gyp-rebuild.mjs'

const require = createRequire(import.meta.url)
const { assertNodePtySourceDeniesMsysBreakaway } = require('./node-pty-job-ownership.cjs')
const { PE_MACHINE, describePeMachine, readPeMachine } = require('./windows-pe-machine.cjs')
const PROBE_SCRIPT = join(import.meta.dirname, 'native-build-entry-probe.cjs')
// Prior in-place build outputs; the scratch copy compiles from source alone.
const SCRATCH_SKIPPED_TOP_LEVEL = new Set(['build', 'bin', 'node_modules'])
const NODE_PTY_CONPTY_RUNTIME_FILES = ['conpty.dll', 'OpenConsole.exe']

/** The compiler environment every Orca node-gyp build of these addons uses. */
export function nativeBuildEnvironment(env = process.env, platform = process.platform) {
  return platform === 'linux'
    ? { ...env, CXXFLAGS: `${env.CXXFLAGS ?? ''} -std=gnu++2a`.trim() }
    : disableMsbuildFileTrackingOnWindows({ ...env })
}

/**
 * Why `dir` cannot serve this runtime, or null when it can. Loads it in a fresh `executable`
 * (Node, or Electron as Node), the only proof an addon is usable.
 */
export function checkNativeBuildDirLoads(moduleName, dir, { executable = process.execPath } = {}) {
  if (
    moduleName === '@vscode/windows-process-tree' &&
    inspectWindowsProcessTreeAddon(join(dir, 'windows_process_tree.node')) !== 'clean'
  ) {
    return `${dir} has no addon built from the patched command-line reader`
  }
  let result
  try {
    result = runProcessSync({
      program: executable,
      args: [PROBE_SCRIPT, moduleName, dir],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: 60_000
    })
  } catch (error) {
    return `the load probe could not start: ${error.message}`
  }
  return result.code === 0
    ? null
    : (result.stderr || result.stdout || describeProcessFailure(result)).trim()
}

/** For a cross-host target nothing here can load: the artifacts must exist and match the arch. */
export function checkNativeBuildDirArtifacts(moduleName, dir, { platform, arch }) {
  const files =
    moduleName === '@vscode/windows-process-tree'
      ? ['windows_process_tree.node']
      : platform === 'win32'
        ? ['conpty.node', ...NODE_PTY_CONPTY_RUNTIME_FILES.map((name) => join('conpty', name))]
        : ['pty.node', ...(platform === 'darwin' ? ['spawn-helper'] : [])]
  const missing = files.find((file) => !existsSync(join(dir, file)))
  if (missing) {
    return `${join(dir, missing)} is missing`
  }
  const machine = platform === 'win32' ? readPeMachine(join(dir, files[0])) : undefined
  if (machine !== undefined && machine !== PE_MACHINE[arch]) {
    return `${join(dir, files[0])} is ${describePeMachine(machine)}, not ${arch}`
  }
  return null
}

/**
 * Make sure `packageDir` holds a usable published build of `moduleName` for platform-arch.
 *
 * `checkBuildDir(dir)` returns why a dir is unusable, or null. Returns the entry dir and whether
 * this call compiled. Throws when no usable entry exists afterwards.
 */
export function ensureSharedNativeBuild({
  moduleName,
  packageDir,
  platform = process.platform,
  arch = process.arch,
  checkBuildDir,
  nodeGypEntry,
  log = console.warn
}) {
  // Why: pinned once, so a concurrent relink can't publish this source's build into another slot.
  const physicalDir = realpathSync(packageDir)
  const entryDir = nativeBuildEntryDir(physicalDir, moduleName, { platform, arch })
  if (existsSync(entryDir)) {
    const reason = checkBuildDir(entryDir)
    if (reason === null) {
      log(`Reusing the shared ${moduleName} build at ${entryDir}.`)
      return { entryDir, built: false }
    }
    log(`The shared ${moduleName} build at ${entryDir} is unusable (${reason}); replacing it.`)
  }
  // node-gyp only compiles for the host OS; publishing that under another platform's name poisons the slot.
  if (platform !== process.platform) {
    throw new Error(
      `cannot build ${moduleName} for ${platform} on ${process.platform}; build it on ${platform}`
    )
  }

  const workDir = mkdtempSync(join(tmpdir(), 'orca-native-build-'))
  try {
    const releaseDir = compileInScratchCopy({
      moduleName,
      physicalDir,
      sourceDir: join(workDir, 'package'),
      arch,
      nodeGypEntry,
      log
    })
    const stagingDir = sharedTreeStagingPath(entryDir)
    mkdirSync(dirname(entryDir), { recursive: true })
    cpSync(releaseDir, stagingDir, {
      recursive: true,
      // windows-process-tree leaves MSBuild intermediates beside its one runtime file.
      filter: (path) =>
        moduleName !== '@vscode/windows-process-tree' ||
        path === releaseDir ||
        path.endsWith('.node')
    })
    const stagedReason = checkBuildDir(stagingDir)
    if (stagedReason !== null) {
      rmSync(stagingDir, { recursive: true, force: true })
      throw new Error(`the freshly built ${moduleName} is unusable: ${stagedReason}`)
    }
    const published = publishSharedTree(stagingDir, entryDir, {
      isUsable: (dir) => checkBuildDir(dir) === null
    })
    if (!published) {
      const reason = checkBuildDir(entryDir)
      if (reason !== null) {
        throw new Error(`could not publish ${entryDir}, and what is there is unusable: ${reason}`)
      }
      log(`Another worktree published ${entryDir} first; using it.`)
    } else {
      log(`Published the shared ${moduleName} build at ${entryDir}.`)
    }
    return { entryDir, built: true }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

function compileInScratchCopy({ moduleName, physicalDir, sourceDir, arch, nodeGypEntry, log }) {
  cpSync(physicalDir, sourceDir, {
    recursive: true,
    dereference: true,
    filter: (path) => !SCRATCH_SKIPPED_TOP_LEVEL.has(relative(physicalDir, path))
  })
  if (moduleName === 'node-pty') {
    stageNodeAddonApi(physicalDir, sourceDir)
    if (process.platform === 'win32') {
      assertNodePtySourceDeniesMsysBreakaway({ nodePtyDir: sourceDir })
    }
  } else if (moduleName === '@vscode/windows-process-tree') {
    // Repairs land in the private copy: the shared slot's source stays exactly as pnpm wrote it.
    ensureWindowsProcessTreeCommandLinePatch(sourceDir)
    stageWindowsProcessTreeNodeAddonApiHeaders(sourceDir, physicalDir)
  }

  log(`Building ${moduleName} for ${arch} in ${sourceDir}.`)
  const env = { ...nativeBuildEnvironment(), npm_config_arch: arch }
  const { args, cwd } = nodeGypRebuildInvocation(arch, sourceDir, nodeGypEntry)
  runOrThrow(`node-gyp rebuild of ${moduleName}`, {
    program: process.execPath,
    args,
    cwd,
    env,
    stdio: 'inherit',
    timeoutMs: nodeGypRebuildTimeoutMs(moduleName)
  })
  if (moduleName === 'node-pty') {
    // node-pty's own post-install trims build/Release to its runtime files and stages ConPTY.
    runOrThrow('node-pty post-install', {
      program: process.execPath,
      args: [join(sourceDir, 'scripts', 'post-install.js')],
      cwd: sourceDir,
      env,
      stdio: 'inherit',
      timeoutMs: 60_000
    })
  }
  return join(sourceDir, 'build', 'Release')
}

function runOrThrow(label, options) {
  const result = runProcessSync(options)
  if (result.code !== 0) {
    throw new Error(`${label} failed in ${options.cwd}: ${describeProcessFailure(result)}`)
  }
}
