// Run node-gyp from physical package dir: node-addon-api probe returns store-relative hop, which escapes store and fails configure from pnpm link cwd (32999886072).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { loadedNativeBuildDir } from './native-build-entry.cjs'

const ROOT = resolve(import.meta.dirname, '..', '..')

export const WINDOWS_PROCESS_TREE_PACKAGE_DIR = join(
  ROOT,
  'node_modules',
  '@vscode',
  'windows-process-tree'
)

export const WINDOWS_PROCESS_TREE_PATCH_PATH = join(
  ROOT,
  'config',
  'patches',
  '@vscode__windows-process-tree@0.8.0.patch'
)

/** Only the patched reader defines this; the upstream one walks the PEB. */
const COMMAND_LINE_PATCH_MARKER = 'kProcessCommandLineInformation'

const CREATION_TIME_PATCH_MARKERS = [
  ['src/process.h', 'CREATIONTIME = 4'],
  ['src/process.h', 'ULONGLONG creationTimeMs'],
  ['src/process.cc', 'GetProcessCreationTime(pinfo)'],
  ['src/process.cc', 'GetProcessTimes(hProcess, &creationTime'],
  ['src/process_worker.cc', 'object.Set("creationTimeMs"'],
  ['src/addon.cc', 'exports.Set("getProcessCreationTime"'],
  ['lib/index.js', '["CreationTime"] = 4'],
  ['lib/index.js', 'exports.getProcessCreationTime'],
  ['lib/index.ts', 'CreationTime = 4'],
  ['lib/index.ts', 'export const getProcessCreationTime'],
  ['typings/windows-process-tree.d.ts', 'creationTimeMs?: number'],
  ['typings/windows-process-tree.d.ts', 'export const getProcessCreationTime']
]

export const WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS = [
  'napi.h',
  'napi-inl.h',
  'napi-inl.deprecated.h'
]

export function nodeGypRebuildInvocation(
  arch,
  packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR,
  nodeGypEntry = join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
) {
  return {
    args: [nodeGypEntry, 'rebuild', `--arch=${arch}`],
    cwd: realpathSync(packageDir)
  }
}

export function nodeGypRebuildTimeoutMs(
  moduleName,
  { platform = process.platform, arch = process.arch, ci = process.env.CI } = {}
) {
  // Cold headers and toolchain discovery consumed over four minutes on Windows ARM CI.
  return moduleName === 'node-pty' && platform === 'win32' && arch === 'arm64' && ci === 'true'
    ? 600_000
    : 300_000
}

/** The binary the addon actually loads: the patched lib/index.js prefers a published entry. */
export function windowsProcessTreeAddonPath(packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR) {
  return join(
    loadedNativeBuildDir(packageDir, '@vscode/windows-process-tree', { platform: 'win32' }),
    'windows_process_tree.node'
  )
}

/** The import whose absence tells the patched binary from the published prebuilt. */
const FLAGGED_IMPORT = 'ReadProcessMemory'

/**
 * Does this compiled addon still carry the flagged primitive?
 *
 * The patched reader never calls `ReadProcessMemory`, so the symbol is absent
 * from its import table; the upstream build imports it. That makes this a
 * property of the binary rather than of the source next to it, which matters
 * because the published tarball ships a *loadable* prebuilt built from
 * unpatched source: it is node-addon-api, so it satisfies a bare `require()`
 * under both Node and Electron, and a skipped rebuild would use it.
 *
 * Tri-state, not a predicate: a binary that is not there has not been cleared,
 * and a boolean makes "absent" indistinguishable from "verified clean" at every
 * call site. Takes the binary path so the relay's staged addon -- which sits
 * beside the bundle, with no package around it -- gets the same check.
 *
 * @param {string} addonPath
 * @returns {'clean' | 'unpatched' | 'missing'}
 */
export function inspectWindowsProcessTreeAddon(addonPath) {
  if (!existsSync(addonPath)) {
    return 'missing'
  }
  return readFileSync(addonPath).includes(FLAGGED_IMPORT) ? 'unpatched' : 'clean'
}

/** Only an addon built with the relay launcher patch registers this export. */
const RELAY_LAUNCHER_EXPORT = 'spawnOutsideJob'

// Require relay-launcher export marker: otherwise clean/loadable stale binary falls back to WMI denied to standard users.
export function windowsProcessTreeAddonHasBreakawayLauncher(addonPath) {
  return readFileSync(addonPath).includes(RELAY_LAUNCHER_EXPORT)
}

/**
 * Why this binary cannot ship as the `arch` relay addon, or null when it can.
 *
 * @param {string} addonPath
 * @param {'x64' | 'arm64'} arch
 * @returns {string | null}
 */
export function windowsProcessTreeAddonDefect(addonPath, arch) {
  const state = inspectWindowsProcessTreeAddon(addonPath)
  if (state === 'missing') {
    return 'it is missing'
  }
  if (state === 'unpatched') {
    return `it imports ${FLAGGED_IMPORT}, so it was built from the unpatched command-line reader`
  }
  const { PE_MACHINE, describePeMachine, readPeMachine } = createRequire(import.meta.url)(
    './windows-pe-machine.cjs'
  )
  const machine = readPeMachine(addonPath)
  if (machine !== PE_MACHINE[arch]) {
    return `it is ${describePeMachine(machine)}, not ${arch} (0x${PE_MACHINE[arch].toString(16)})`
  }
  if (!windowsProcessTreeAddonHasBreakawayLauncher(addonPath)) {
    return `it does not export ${RELAY_LAUNCHER_EXPORT}, so it predates the relay launcher patch`
  }
  return null
}

export function assertWindowsProcessTreeCreationTimePatch(
  packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR
) {
  for (const [relativePath, expected] of CREATION_TIME_PATCH_MARKERS) {
    const filePath = join(packageDir, relativePath)
    if (!existsSync(filePath)) {
      throw new Error(
        `${filePath} is missing, so the process creation-time patch cannot be verified. ` +
          'Run pnpm install.'
      )
    }
    if (!readFileSync(filePath, 'utf8').includes(expected)) {
      throw new Error(
        `${relativePath} does not contain the process creation-time patch (${expected}). ` +
          'Run pnpm install.'
      )
    }
  }
}

export function assertWindowsProcessTreeRuntimeCreationTime(windowsProcessTree) {
  if (windowsProcessTree?.ProcessDataFlag?.CreationTime !== 4) {
    throw new Error(
      '@vscode/windows-process-tree does not expose ProcessDataFlag.CreationTime, so native ' +
        'Windows structured agent-session process ownership cannot be PID-reuse safe. Rebuild it ' +
        '(pnpm run rebuild:electron) rather than using the published prebuild.'
    )
  }
}

// Repair missing CRLF package patch and drop stale prebuilt: upstream reader walks PEB with PROCESS_VM_READ, the MDE-flagged primitive patch removes.
export function ensureWindowsProcessTreeCommandLinePatch(
  packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR
) {
  const source = join(packageDir, 'src', 'process_commandline.cc')
  if (!existsSync(source)) {
    throw new Error(
      `${source} is missing, so the command-line patch cannot be verified. Run pnpm install.`
    )
  }
  let repaired = false

  if (!readFileSync(source, 'utf8').includes(COMMAND_LINE_PATCH_MARKER)) {
    try {
      execFileSync(
        'git',
        [
          // Force autocrlf=input to normalize LF patch against upstream CRLF under all host modes; default false fails literal matching. Real content drift still rejects hunk.
          '-c',
          'core.autocrlf=input',
          'apply',
          '--include=src/process_commandline.cc',
          WINDOWS_PROCESS_TREE_PATCH_PATH
        ],
        {
          cwd: realpathSync(packageDir),
          stdio: 'pipe',
          // Hide repo from git apply: worktree cwd prefix can silently skip every patch path with exit 0 while changing nothing.
          env: { ...process.env, GIT_DIR: join(packageDir, '.orca-no-such-git-dir') }
        }
      )
    } catch (error) {
      throw new Error(
        'src/process_commandline.cc still reads the PEB, and repairing it from ' +
          `${WINDOWS_PROCESS_TREE_PATCH_PATH} failed: ${error?.message ?? error}. Run pnpm install.`
      )
    }
    if (!readFileSync(source, 'utf8').includes(COMMAND_LINE_PATCH_MARKER)) {
      throw new Error(
        'src/process_commandline.cc still reads the PEB after repair, so the patch did not ' +
          'apply. Run pnpm install.'
      )
    }
    repaired = true
  }

  // Delete stale/tarball prebuilt or skipped rebuild loads unsafe reader. Propagate loaded-addon EPERM for caller’s lock classifier; force only suppresses ENOENT.
  if (inspectWindowsProcessTreeAddon(windowsProcessTreeAddonPath(packageDir)) === 'unpatched') {
    rmSync(windowsProcessTreeAddonPath(packageDir), { force: true })
    repaired = true
  }
  assertWindowsProcessTreeCreationTimePatch(packageDir)

  return repaired
}

// Stage node-addon-api headers absent from tarball; scratch package resolves them through installed resolveFromDir.
export function stageWindowsProcessTreeNodeAddonApiHeaders(
  packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR,
  resolveFromDir = packageDir
) {
  const nodeAddonApiDir = dirname(
    createRequire(join(resolveFromDir, 'package.json')).resolve('node-addon-api/package.json')
  )
  const stagedHeaderDir = join(packageDir, 'deps', 'node-addon-api')
  mkdirSync(stagedHeaderDir, { recursive: true })
  for (const header of WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS) {
    copyFileSync(join(nodeAddonApiDir, header), join(stagedHeaderDir, header))
  }
  return stagedHeaderDir
}
