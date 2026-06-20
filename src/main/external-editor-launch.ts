import { basename, win32 } from 'node:path'
import { resolveCliCommand } from './codex-cli/command'
import { getCmdExePath } from './win32-utils'

export const EXTERNAL_EDITOR_CLI_COMMAND = 'code'

export type ExternalEditorLaunchSpec =
  | {
      kind: 'executable'
      spawnCmd: string
      spawnArgs: string[]
    }
  | {
      kind: 'shell'
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

function getLauncherBaseName(command: string): string {
  const name = command.includes('\\') ? win32.basename(command) : basename(command)
  return name.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()
}

function buildExecutableArgs(editorCommand: string, pathValue: string): string[] {
  if (getLauncherBaseName(editorCommand) === 'cursor') {
    // Why: Cursor can route bare folder launches through the last active
    // workbench. A new window keeps "Open in Cursor" scoped to this worktree.
    return ['--new-window', pathValue]
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
      spawnCmd: getCmdExePath(),
      spawnArgs: ['/d', '/s', '/c', shellCommand]
    }
  }
  return {
    kind: 'shell',
    spawnCmd: '/bin/sh',
    spawnArgs: ['-c', shellCommand]
  }
}

export function resolveExternalEditorLaunchSpec(
  command: string | undefined,
  pathValue: string,
  options: { platform?: NodeJS.Platform } = {}
): ExternalEditorLaunchSpec {
  const platform = options.platform ?? process.platform
  const trimmed = command?.trim() || EXTERNAL_EDITOR_CLI_COMMAND

  if (isCompoundShellCommand(trimmed)) {
    return buildShellLaunchSpec(trimmed, pathValue, platform)
  }

  const editorCommand = resolveCliCommand(trimmed, { platform })
  return {
    kind: 'executable',
    spawnCmd: editorCommand,
    spawnArgs: buildExecutableArgs(editorCommand, pathValue)
  }
}
