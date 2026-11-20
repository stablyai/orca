import { access, constants } from 'node:fs/promises'
import { resolveProviderExecPath } from './provider-process-supervisor'

let missingLogged = false

/**
 * Linux only: a child otherwise inherits main's Chromium IPC sockets, so after main crashes its
 * renderer, GPU and utility processes outlive it for as long as that child runs.
 */
export async function resolveFdClosingExec(): Promise<string | undefined> {
  if (process.platform !== 'linux') {
    return undefined
  }
  let path = 'orca-provider-exec'
  try {
    path = resolveProviderExecPath('linux')
    await access(path, constants.X_OK)
    return path
  } catch {
    if (!missingLogged) {
      missingLogged = true
      console.warn(
        `[fd-closing-exec] ${path} is unavailable; children will inherit main's descriptors`
      )
    }
    return undefined
  }
}
