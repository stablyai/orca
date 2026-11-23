import { basename } from 'node:path'

/** Match local spawn shell precedence: request → default setting → SHELL.
 * Remote relays and Windows shell families cannot be named by this POSIX lookup. */
export function nameLocalTypedLineShell(args: {
  isRemote: boolean
  shellOverride?: string
  defaultShellSetting?: string
  platform?: NodeJS.Platform
  envShell?: string
}): string | undefined {
  if (args.isRemote || (args.platform ?? process.platform) === 'win32') {
    return undefined
  }
  const shellPath =
    args.shellOverride?.trim() ||
    args.defaultShellSetting?.trim() ||
    (args.envShell ?? process.env.SHELL) ||
    '/bin/zsh'
  return basename(shellPath).toLowerCase()
}

/** Foreground proof depends on the execution host: local WSL still uses Windows PTY machinery; SSH uses its host platform. */
export function launchHostProvesAgentInFront(args: {
  isRemote: boolean
  launchPlatform: NodeJS.Platform
  hostPlatform?: NodeJS.Platform
}): boolean {
  return args.isRemote
    ? args.launchPlatform !== 'win32'
    : (args.hostPlatform ?? process.platform) !== 'win32'
}
