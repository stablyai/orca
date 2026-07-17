import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { applyWindowsNodePtySettlement } from './ssh-relay-node-pty-windows-settlement.mjs'
import {
  applyWindowsNodePtyBuildDeterminism,
  assertWindowsNodePtyGeneratedBuildSettings,
  inspectWindowsNodePtyLinkCommandTracking
} from './ssh-relay-node-pty-windows-build-determinism.mjs'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const NODE_GYP_PATH = require.resolve('node-gyp/bin/node-gyp.js')
const NODE_ADDON_API_DIRECTORY = dirname(require.resolve('node-addon-api/package.json'))
const BUILD_TIMEOUT_MS = 10 * 60 * 1000
const COMMAND_TIMEOUT_MS = 60 * 1000
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024

export function nodePtyNativeBuildCommands({ nodePath, nodeRoot, tuple }) {
  const nodeGypArguments = ['--release', `--nodedir=${nodeRoot}`]
  if (!tuple.startsWith('darwin-')) {
    return [{ command: nodePath, args: [NODE_GYP_PATH, 'rebuild', ...nodeGypArguments] }]
  }
  return [
    { command: nodePath, args: [NODE_GYP_PATH, 'configure', ...nodeGypArguments] },
    {
      command: 'make',
      // Why: a canonical build path plus this flag retains a loadable, reproducible Mach-O UUID.
      args: ['-C', 'build', 'BUILDTYPE=Release', 'LDFLAGS.target=-Wl,-reproducible']
    }
  ]
}

async function runCommand(command, args, options = {}) {
  // Why: native build tools can be noisy or hang; both cases must settle within explicit bounds.
  const result = await execFileAsync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
    windowsHide: true
  })
  if (result.stdout) {
    process.stdout.write(result.stdout)
  }
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
  return result
}

function sourceFilter(source) {
  const normalized = source.replaceAll('\\', '/')
  return !/(?:^|\/)build(?:\/|$)/.test(normalized) && !/(?:^|\/)prebuilds(?:\/|$)/.test(normalized)
}

async function assertPatchedSource(nodePtyDirectory) {
  const [unixTerminal, ptySource, windowsAgent] = await Promise.all([
    readFile(join(nodePtyDirectory, 'lib', 'unixTerminal.js'), 'utf8'),
    readFile(join(nodePtyDirectory, 'src', 'unix', 'pty.cc'), 'utf8'),
    readFile(join(nodePtyDirectory, 'lib', 'conpty_console_list_agent.js'), 'utf8')
  ])
  if (
    !unixTerminal.includes("if (!helperPath.includes('app.asar.unpacked'))") ||
    !ptySource.includes('pty_format_spawn_error') ||
    !windowsAgent.includes('consoleProcessList = [shellPid]')
  ) {
    throw new Error('node-pty source is missing Orca-required patch markers')
  }
}

async function assertBuiltArtifacts(buildDirectory, tuple) {
  const releaseDirectory = join(buildDirectory, 'build', 'Release')
  const nativePaths = tuple.startsWith('win32-')
    ? [
        'conpty.node',
        'conpty_console_list.node',
        'pty.node',
        'conpty/conpty.dll',
        'conpty/OpenConsole.exe'
      ]
    : ['pty.node']
  for (const path of nativePaths) {
    if (!(await stat(join(releaseDirectory, ...path.split('/')))).isFile()) {
      throw new Error(`node-pty did not produce build/Release/${path}`)
    }
  }
  if (tuple.startsWith('darwin-')) {
    const helperPath = join(releaseDirectory, 'spawn-helper')
    const helper = await stat(helperPath)
    if (!helper.isFile() || (helper.mode & 0o111) === 0) {
      throw new Error('macOS node-pty did not produce executable build/Release/spawn-helper')
    }
  }
}

async function stageWindowsConptyRuntime(buildDirectory, tuple) {
  if (!tuple.startsWith('win32-')) {
    return
  }
  const conptyRoot = join(buildDirectory, 'third_party', 'conpty')
  const versions = (await readdir(conptyRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory()
  )
  if (versions.length !== 1) {
    throw new Error('node-pty must contain exactly one pinned ConPTY runtime version')
  }
  const architecture = tuple.endsWith('-arm64') ? 'arm64' : 'x64'
  const sourceDirectory = join(conptyRoot, versions[0].name, `win10-${architecture}`)
  const destinationDirectory = join(buildDirectory, 'build', 'Release', 'conpty')
  await mkdir(destinationDirectory)
  // Why: direct node-gyp bypasses node-pty's postinstall, while Orca explicitly uses this DLL path.
  for (const name of ['conpty.dll', 'OpenConsole.exe']) {
    const sourcePath = join(sourceDirectory, name)
    if (!(await stat(sourcePath)).isFile()) {
      throw new Error(`node-pty is missing pinned ${architecture} ConPTY runtime file: ${name}`)
    }
    await copyFile(sourcePath, join(destinationDirectory, name))
  }
}

async function stripBuiltArtifacts(buildDirectory, tuple) {
  const releaseDirectory = join(buildDirectory, 'build', 'Release')
  const ptyPath = join(releaseDirectory, 'pty.node')
  if (tuple.startsWith('linux-')) {
    await runCommand('strip', ['--strip-unneeded', ptyPath], {
      windowsHide: true,
      env: process.env
    })
  } else if (tuple.startsWith('darwin-')) {
    await runCommand('strip', ['-S', ptyPath, join(releaseDirectory, 'spawn-helper')], {
      windowsHide: true,
      env: process.env
    })
  }
}

export async function buildPatchedSshRelayNodePty({
  projectRoot,
  nodePath,
  nodeRoot,
  nodeVersion,
  tuple,
  buildDirectory
}) {
  const sourceDirectory = resolve(projectRoot, 'node_modules', 'node-pty')
  await assertPatchedSource(sourceDirectory)
  await mkdir(buildDirectory)
  await cp(sourceDirectory, buildDirectory, {
    recursive: true,
    dereference: true,
    filter: sourceFilter
  })
  await applyWindowsNodePtyBuildDeterminism({ nodePtyDirectory: buildDirectory, tuple })
  await applyWindowsNodePtySettlement({
    nodePtyLibraryDirectory: join(buildDirectory, 'lib'),
    tuple
  })
  await mkdir(join(buildDirectory, 'node_modules'), { recursive: true })
  await cp(NODE_ADDON_API_DIRECTORY, join(buildDirectory, 'node_modules', 'node-addon-api'), {
    recursive: true,
    dereference: true
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BUILD_TIMEOUT_MS)
  try {
    const buildEnvironment = {
      ...process.env,
      PATH: `${dirname(nodePath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      npm_config_arch: tuple.includes('arm64') ? 'arm64' : 'x64',
      npm_config_build_from_source: 'true',
      npm_config_nodedir: nodeRoot,
      // Why: a successful build must prove all Node inputs were staged, never fetched implicitly.
      npm_config_offline: 'true',
      npm_config_disturl: 'http://127.0.0.1:9',
      npm_config_target: nodeVersion
    }
    for (const buildCommand of nodePtyNativeBuildCommands({ nodePath, nodeRoot, tuple })) {
      await runCommand(buildCommand.command, buildCommand.args, {
        cwd: buildDirectory,
        signal: controller.signal,
        timeout: BUILD_TIMEOUT_MS,
        windowsHide: true,
        env: buildEnvironment
      })
    }
    const generatedSettings = await assertWindowsNodePtyGeneratedBuildSettings({
      nodePtyDirectory: buildDirectory,
      tuple
    })
    if (generatedSettings) {
      // Why: MSBuild tracking layout differs by runner, so selection is bounded by target content.
      const linkCommand = await inspectWindowsNodePtyLinkCommandTracking({
        nodePtyDirectory: buildDirectory,
        tuple
      })
      process.stdout.write(
        `windows_node_pty_msbuild_settings=${JSON.stringify({
          ...generatedSettings,
          linkCommand
        })}\n`
      )
    }
  } finally {
    clearTimeout(timeout)
  }
  await stageWindowsConptyRuntime(buildDirectory, tuple)
  await assertBuiltArtifacts(buildDirectory, tuple)
  await stripBuiltArtifacts(buildDirectory, tuple)

  // Why: loading with the bundled executable catches an accidental host-ABI build immediately.
  const nativeNames = tuple.startsWith('win32-') ? ['conpty', 'conpty_console_list'] : ['pty']
  await runCommand(
    nodePath,
    [
      '-e',
      `const {loadNativeModule}=require(${JSON.stringify(join(buildDirectory, 'lib', 'utils.js'))});` +
        `for(const name of ${JSON.stringify(nativeNames)}){` +
        `const loaded=loadNativeModule(name);` +
        `if(!loaded.dir.replace(/\\\\/g,'/').includes('build/Release/'))process.exit(2);}`
    ],
    { cwd: buildDirectory, windowsHide: true, env: process.env }
  )
  return { buildDirectory, releaseDirectory: join(buildDirectory, 'build', 'Release') }
}
