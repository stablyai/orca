import { quotePosixShellUnlessPlain } from '../shared/shell-argument-quoting'
import { spawn, type ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { parseWslUncPath } from '../shared/wsl-paths'
import { isVsCodeLauncherExecutable } from '../shared/vscode-remote-ssh-launcher'
import { resolveCliCommand } from './codex-cli/command'
import { envWithoutAppImageRuntime } from './pty/appimage-terminal-env'
import {
  getLauncherBaseName,
  hasMatchingOuterQuotes,
  stripMatchingQuotes
} from './editor-launcher-name'
import {
  isJetBrainsConsoleShim,
  resolveColocatedJetBrainsGuiExecutable
} from './jetbrains-windows-gui-launchers'
import { findInstalledVsCodeCli } from './vscode-cli-install-paths'
import { getCmdExePath, getSpawnArgsForWindows } from './win32-utils'

export const EXTERNAL_EDITOR_CLI_COMMAND = 'code'
const WINDOWS_CONSOLE_EDITORS = new Set(['nvim', 'vim'])

export type ExternalEditorExecutableLaunchSpec = {
  kind: 'executable'
  hideWindowsConsole: boolean
  /** Detach Windows GUI shims via start /B only when required; start re-parses quoted argv. */
  detachedGui?: boolean
  spawnCmd: string
  spawnArgs: string[]
}

export type ExternalEditorShellLaunchSpec = {
  kind: 'shell'
  hideWindowsConsole: boolean
  spawnCmd: string
  spawnArgs: string[]
}

export type ExternalEditorLaunchSpec =
  | ExternalEditorExecutableLaunchSpec
  | ExternalEditorShellLaunchSpec

function escapeWindowsPathForShell(pathValue: string): string {
  return /^[a-zA-Z0-9_./@:\\-]+$/.test(pathValue) ? pathValue : `"${pathValue}"`
}

function escapePathForShell(pathValue: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? escapeWindowsPathForShell(pathValue)
    : quotePosixShellUnlessPlain(pathValue)
}

function isWindowsExecutablePath(command: string): boolean {
  return win32.isAbsolute(command) && /\.(?:cmd|exe|bat|com)$/i.test(command)
}

function isDirectExecutablePath(
  command: string,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean
): boolean {
  const unquoted = stripMatchingQuotes(command)
  if (!/[\\/]/.test(unquoted)) {
    return false
  }
  const isAbsolutePath =
    platform === 'win32' ? win32.isAbsolute(unquoted) : posix.isAbsolute(unquoted)
  if (!isAbsolutePath) {
    return false
  }
  if (!/\s/.test(unquoted) || hasMatchingOuterQuotes(command)) {
    return true
  }
  // An unquoted POSIX path with spaces is ambiguous; only treat existing files as executables.
  return platform === 'win32' ? isWindowsExecutablePath(unquoted) : fileExists(unquoted)
}

function shouldShowWindowsConsole(
  command: string,
  platform: NodeJS.Platform,
  options: { shellCommand?: boolean } = {}
): boolean {
  return platform === 'win32' && WINDOWS_CONSOLE_EDITORS.has(getLauncherBaseName(command, options))
}

function buildExecutableArgs(
  editorCommand: string,
  pathValue: string,
  platform: NodeJS.Platform
): string[] {
  const isCursor = getLauncherBaseName(editorCommand) === 'cursor'
  const targetArgs = buildWslRemoteTargetArgs(editorCommand, pathValue, platform, isCursor)
  // Cursor may reuse the last workbench; a new window preserves this workspace target.
  return isCursor ? ['--new-window', ...targetArgs] : targetArgs
}

function buildWslRemoteTargetArgs(
  editorCommand: string,
  pathValue: string,
  platform: NodeJS.Platform,
  isCursor: boolean
): string[] {
  if (platform !== 'win32' || !(isCursor || isVsCodeLauncherExecutable(editorCommand))) {
    return [pathValue]
  }
  const wslPath = parseWslUncPath(pathValue)
  // Both editors interpret WSL UNC paths as local Windows folders without --remote.
  return wslPath ? ['--remote', `wsl+${wslPath.distro}`, wslPath.linuxPath] : [pathValue]
}

function isCompoundShellCommand(command: string): boolean {
  return /\s/.test(command)
}

function preferJetBrainsGuiExecutable(
  editorCommand: string,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean
): string {
  if (platform !== 'win32') {
    return editorCommand
  }
  return resolveColocatedJetBrainsGuiExecutable(editorCommand, fileExists) ?? editorCommand
}

function resolveEditorCliCommand(
  command: string,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean
): string {
  const resolved = resolveCliCommand(command, { platform })
  return resolved === command
    ? (findInstalledVsCodeCli(command, platform, fileExists) ?? command)
    : resolved
}

function resolveSimpleEditorCommand(
  command: string,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean
): string {
  return preferJetBrainsGuiExecutable(
    resolveEditorCliCommand(command, platform, fileExists),
    platform,
    fileExists
  )
}

function buildExecutableLaunchSpec(
  editorCommand: string,
  pathValue: string,
  platform: NodeJS.Platform
): ExternalEditorExecutableLaunchSpec {
  const spec: ExternalEditorExecutableLaunchSpec = {
    kind: 'executable',
    hideWindowsConsole: !shouldShowWindowsConsole(editorCommand, platform),
    spawnCmd: editorCommand,
    spawnArgs: buildExecutableArgs(editorCommand, pathValue, platform)
  }
  if (spec.hideWindowsConsole && isJetBrainsConsoleShim(editorCommand, platform)) {
    spec.detachedGui = true
  }
  return spec
}

function buildShellLaunchSpec(
  command: string,
  pathValue: string,
  platform: NodeJS.Platform
): ExternalEditorLaunchSpec {
  const shellCommand = `${command} ${escapePathForShell(pathValue, platform)}`
  if (platform === 'win32') {
    // Do not wrap shell commands in start: it consumes quoted titles and can leave cmd /K running.
    return {
      kind: 'shell',
      hideWindowsConsole: !shouldShowWindowsConsole(command, platform, { shellCommand: true }),
      spawnCmd: getCmdExePath(),
      spawnArgs: ['/d', '/s', '/c', shellCommand]
    }
  }
  return {
    kind: 'shell',
    hideWindowsConsole: true,
    spawnCmd: '/bin/sh',
    spawnArgs: ['-c', shellCommand]
  }
}

export function resolveExternalEditorLaunchSpec(
  command: string | undefined,
  pathValue: string,
  options: { platform?: NodeJS.Platform; fileExists?: (path: string) => boolean } = {}
): ExternalEditorLaunchSpec {
  const platform = options.platform ?? process.platform
  const fileExists = options.fileExists ?? existsSync
  const trimmed = command?.trim() || EXTERNAL_EDITOR_CLI_COMMAND

  if (isDirectExecutablePath(trimmed, platform, fileExists)) {
    // Upgrade explicit JetBrains paths to a colocated GUI executable, just like PATH-resolved names.
    return buildExecutableLaunchSpec(
      preferJetBrainsGuiExecutable(stripMatchingQuotes(trimmed), platform, fileExists),
      pathValue,
      platform
    )
  }

  if (isCompoundShellCommand(trimmed)) {
    return buildShellLaunchSpec(trimmed, pathValue, platform)
  }

  return buildExecutableLaunchSpec(
    resolveSimpleEditorCommand(trimmed, platform, fileExists),
    pathValue,
    platform
  )
}

export function resolveVsCodeRemoteSshLaunchSpec(
  command: string | undefined,
  pathValue: string,
  authority: string,
  options: { platform?: NodeJS.Platform; fileExists?: (path: string) => boolean } = {}
): ExternalEditorLaunchSpec | null {
  const platform = options.platform ?? process.platform
  const fileExists = options.fileExists ?? existsSync
  const trimmed = command?.trim() || EXTERNAL_EDITOR_CLI_COMMAND

  let editorCommand: string
  if (isDirectExecutablePath(trimmed, platform, fileExists)) {
    editorCommand = stripMatchingQuotes(trimmed)
  } else {
    if (isCompoundShellCommand(trimmed)) {
      return null
    }
    editorCommand = resolveEditorCliCommand(trimmed, platform, fileExists)
  }

  if (!isVsCodeLauncherExecutable(editorCommand)) {
    return null
  }
  return {
    kind: 'executable',
    hideWindowsConsole: true,
    spawnCmd: editorCommand,
    spawnArgs: ['--remote', `ssh-remote+${authority}`, pathValue]
  }
}

function startExternalEditorProcess(launchSpec: ExternalEditorLaunchSpec): ChildProcess {
  const detachedOptions = {
    detached: true,
    stdio: 'ignore',
    // AppImage exports ARGV0, APPDIR, and mount PATH entries that editor shells must not inherit.
    env: process.platform === 'linux' ? envWithoutAppImageRuntime(process.env) : undefined
  } as const
  if (launchSpec.kind === 'shell') {
    const { spawnCmd, spawnArgs, hideWindowsConsole } = launchSpec
    return hideWindowsConsole
      ? spawnProcess({ program: spawnCmd, args: spawnArgs, ...detachedOptions })
      : spawn(spawnCmd, spawnArgs, { ...detachedOptions, windowsHide: false })
  }
  if (launchSpec.hideWindowsConsole && !launchSpec.detachedGui) {
    // process-host preserves quoting for batch launchers and arguments containing spaces.
    return spawnProcess({
      program: launchSpec.spawnCmd,
      args: launchSpec.spawnArgs,
      ...detachedOptions
    })
  }
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(
    launchSpec.spawnCmd,
    launchSpec.spawnArgs,
    {
      detachedGui: launchSpec.detachedGui === true
    }
  )
  if (!launchSpec.hideWindowsConsole) {
    // process-host hides consoles; Windows terminal editors need a visible console.
    return spawn(spawnCmd, spawnArgs, { ...detachedOptions, windowsHide: false })
  }
  return spawnProcess({ program: spawnCmd, args: spawnArgs, ...detachedOptions })
}

export async function launchExternalEditor(launchSpec: ExternalEditorLaunchSpec): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = startExternalEditorProcess(launchSpec)
    let settled = false
    function cleanup(): void {
      child.off('error', onError)
      child.off('spawn', onSpawn)
    }
    function settle(callback: () => void): void {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      callback()
    }
    function onError(error: Error): void {
      settle(() => rejectPromise(error))
    }
    function onSpawn(): void {
      child.unref()
      settle(resolvePromise)
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
}
