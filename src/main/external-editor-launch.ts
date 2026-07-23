import { existsSync } from 'node:fs'
import { basename, posix, win32 } from 'node:path'
import { parseWslUncPath } from '../shared/wsl-paths'
import { isVsCodeLauncherExecutable } from '../shared/vscode-remote-ssh-launcher'
import { resolveCliCommand } from './codex-cli/command'
import { getCmdExePath } from './win32-utils'

export const EXTERNAL_EDITOR_CLI_COMMAND = 'code'
const WINDOWS_CONSOLE_EDITORS = new Set(['nvim', 'vim'])

export type ExternalEditorLaunchSpec =
  | {
      kind: 'executable'
      hideWindowsConsole: boolean
      spawnCmd: string
      spawnArgs: string[]
    }
  | {
      kind: 'shell'
      hideWindowsConsole: boolean
      spawnCmd: string
      spawnArgs: string[]
    }

function escapePosixPathForShell(pathValue: string): string {
  if (/^[a-zA-Z0-9_./@:-]+$/.test(pathValue)) {
    return pathValue
  }
  return `'${pathValue.replace(/'/g, "'\\''")}'`
}

function escapeWindowsPathForShell(pathValue: string): string {
  return /^[a-zA-Z0-9_./@:\\-]+$/.test(pathValue) ? pathValue : `"${pathValue}"`
}

function escapePathForShell(pathValue: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? escapeWindowsPathForShell(pathValue)
    : escapePosixPathForShell(pathValue)
}

function getLauncherBaseName(command: string, options: { shellCommand?: boolean } = {}): string {
  const normalized = options.shellCommand
    ? getLeadingShellCommandToken(command)
    : stripMatchingQuotes(command)
  const name = normalized.includes('\\') ? win32.basename(normalized) : basename(normalized)
  return name.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()
}

function getLeadingShellCommandToken(command: string): string {
  const trimmed = command.trim()
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    const closingIndex = trimmed.indexOf(quote, 1)
    if (closingIndex > 0) {
      return trimmed.slice(1, closingIndex)
    }
  }
  return trimmed.split(/\s+/, 1)[0] ?? ''
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function hasMatchingOuterQuotes(value: string): boolean {
  const trimmed = value.trim()
  const quote = trimmed[0]
  return (quote === '"' || quote === "'") && trimmed.endsWith(quote)
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
  // Why: unquoted POSIX paths can contain spaces, but so can shell commands
  // with arguments. Only an existing path is safe to treat as one executable.
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
  const launcherBaseName = getLauncherBaseName(editorCommand)
  if (launcherBaseName === 'cursor') {
    // Why: Cursor can route bare folder launches through the last active
    // workbench. A new window keeps "Open in Cursor" scoped to this worktree.
    return ['--new-window', pathValue]
  }
  if (platform === 'win32' && isVsCodeLauncherExecutable(editorCommand)) {
    const wslPath = parseWslUncPath(pathValue)
    if (wslPath) {
      // Why: VS Code otherwise treats a WSL UNC path as a local Windows folder.
      return ['--remote', `wsl+${wslPath.distro}`, wslPath.linuxPath]
    }
  }
  return [pathValue]
}

function isCompoundShellCommand(command: string): boolean {
  return /\s/.test(command)
}

function buildShellLaunchSpec(
  command: string,
  pathValue: string,
  platform: NodeJS.Platform
): ExternalEditorLaunchSpec {
  const shellCommand = `${command} ${escapePathForShell(pathValue, platform)}`
  if (platform === 'win32') {
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
    const editorCommand = stripMatchingQuotes(trimmed)
    return {
      kind: 'executable',
      hideWindowsConsole: !shouldShowWindowsConsole(editorCommand, platform),
      spawnCmd: editorCommand,
      spawnArgs: buildExecutableArgs(editorCommand, pathValue, platform)
    }
  }

  if (isCompoundShellCommand(trimmed)) {
    return buildShellLaunchSpec(trimmed, pathValue, platform)
  }

  const editorCommand = resolveCliCommand(trimmed, { platform })
  return {
    kind: 'executable',
    hideWindowsConsole: !shouldShowWindowsConsole(editorCommand, platform),
    spawnCmd: editorCommand,
    spawnArgs: buildExecutableArgs(editorCommand, pathValue, platform)
  }
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
    editorCommand = resolveCliCommand(trimmed, { platform })
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
