import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import type { ExternalEditorLaunchSpec } from './external-editor-launch'
import { isCompoundShellCommand, isDirectExecutablePath } from './external-editor-launch'
import { resolveCliCommand } from './codex-cli/command'
import { stripMatchingQuotes } from './editor-launcher-name'
import {
  getZedLauncherCommandToken,
  isZedLauncherExecutable
} from '../shared/zed-remote-ssh-launcher'

function encodeRemoteSshPath(pathValue: string): string {
  return pathValue
    .split('/')
    .map((segment, index) => (index === 0 ? '' : encodeURIComponent(segment)))
    .join('/')
}

function formatZedSshAuthority(authority: string): string | null {
  if (!authority || /[\s/?#\\%]/.test(authority)) {
    return null
  }
  const separatorIndex = authority.indexOf('@')
  if (separatorIndex !== -1 && separatorIndex !== authority.lastIndexOf('@')) {
    return null
  }
  const user = separatorIndex !== -1 ? authority.slice(0, separatorIndex + 1) : ''
  const host = separatorIndex !== -1 ? authority.slice(separatorIndex + 1) : authority
  if (!host) {
    return null
  }
  const bracketed = host.startsWith('[') && host.endsWith(']')
  if (host.includes('[') || host.includes(']')) {
    return bracketed && host.includes(':') ? authority : null
  }
  if (!host.includes(':')) {
    return authority
  }
  return /^[0-9a-f:]+$/i.test(host) ? `${user}[${host}]` : null
}

export function resolveZedRemoteSshLaunchSpec(
  command: string | undefined,
  pathValue: string,
  authority: string,
  options: { platform?: NodeJS.Platform; fileExists?: (path: string) => boolean } = {}
): ExternalEditorLaunchSpec | null {
  const formattedAuthority = formatZedSshAuthority(authority)
  if (!posix.isAbsolute(pathValue) || !formattedAuthority) {
    return null
  }

  const platform = options.platform ?? process.platform
  const fileExists = options.fileExists ?? existsSync
  const trimmed = command?.trim()
  if (!trimmed) {
    return null
  }

  const commandToken = getZedLauncherCommandToken(trimmed)
  const unquoted = stripMatchingQuotes(trimmed)
  const hasArguments = unquoted !== commandToken
  const editorCommand = isDirectExecutablePath(trimmed, platform, fileExists)
    ? stripMatchingQuotes(trimmed)
    : isDirectExecutablePath(commandToken, platform, fileExists)
      ? commandToken
      : !hasArguments && !isCompoundShellCommand(trimmed)
        ? resolveCliCommand(commandToken, { platform })
        : null
  if (!editorCommand || !isZedLauncherExecutable(editorCommand)) {
    return null
  }
  return {
    kind: 'executable',
    hideWindowsConsole: true,
    spawnCmd: editorCommand,
    spawnArgs: ['--new', `ssh://${formattedAuthority}${encodeRemoteSshPath(pathValue)}`]
  }
}
