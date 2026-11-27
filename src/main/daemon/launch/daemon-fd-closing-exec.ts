import { access, constants } from 'node:fs/promises'
import { resolveProviderExecPath } from '../../provider-process/provider-exec-path'

export const FD_CLOSING_EXEC_ARGS = ['--exec-without-inherited-fds', '--'] as const

let missingLogged = false

/**
 * Linux only: a detached daemon otherwise inherits main's Chromium IPC sockets, so after main
 * crashes its children never see it go and the orphaned backend keeps the next launch's lock.
 */
export async function resolveDaemonFdClosingExec(): Promise<string | undefined> {
  if (process.platform !== 'linux') {
    return undefined
  }
  const path = resolveProviderExecPath('linux')
  try {
    await access(path, constants.X_OK)
    return path
  } catch {
    if (!missingLogged) {
      missingLogged = true
      console.warn(
        `[daemon] ${path} is missing; the daemon will inherit this process's descriptors`
      )
    }
    return undefined
  }
}
