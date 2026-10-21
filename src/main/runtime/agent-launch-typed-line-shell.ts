import { basename } from 'node:path'

/**
 * The shell a local pane's startup line gets typed into, named before the spawn the way the spawn
 * picks it: the request's shell, the default-shell setting, then `SHELL`
 * (`ipc/pty/runtime/spawn-preflight.ts`, then the local or daemon launch plan).
 *
 * Undefined where the host cannot name it: a remote host, whose relay picks its own login shell,
 * and Windows, whose pane may be cmd, PowerShell, Git Bash or a WSL distro.
 */
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

/**
 * Whether the execution host can prove a launched agent holds its terminal before a paste
 * (`launched-agent-foreground`). A Windows host cannot, and a local WSL pane runs on one; an SSH
 * host is judged by its own platform.
 */
export function launchHostProvesAgentInFront(args: {
  isRemote: boolean
  launchPlatform: NodeJS.Platform
  hostPlatform?: NodeJS.Platform
}): boolean {
  return args.isRemote
    ? args.launchPlatform !== 'win32'
    : (args.hostPlatform ?? process.platform) !== 'win32'
}
