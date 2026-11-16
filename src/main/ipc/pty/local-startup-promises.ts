import { settledDaemonRestart } from '../../daemon/providers/lifecycle/daemon-restart-state'

import type { ResolvedPtyHost } from './provider/registry'

import type { PtyIpcSessionOptions } from './session'

import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export function createLocalPtyStartupPromises(options?: PtyIpcSessionOptions) {
  // Only local PTYs change ownership during this machine's daemon swap.
  const getLocalPtyStartupPromise = (
    hostId: ResolvedPtyHost = LOCAL_EXECUTION_HOST_ID
  ): Promise<void> | undefined => {
    if (hostId !== LOCAL_EXECUTION_HOST_ID) {
      return undefined
    }
    // Cold-start local spawns must await daemon handoff; other hosts own their startup.
    const startup = options?.awaitLocalPtyStartup?.()
    // Restart replacements must reach the new daemon.
    const restart = settledDaemonRestart()
    return startup && restart
      ? Promise.all([startup, restart]).then(() => undefined)
      : (startup ?? restart)
  }

  const getLocalPtyProviderStartupPromise = (
    hostId: ResolvedPtyHost = LOCAL_EXECUTION_HOST_ID
  ): Promise<void> | undefined => {
    return hostId === LOCAL_EXECUTION_HOST_ID
      ? (options?.awaitLocalPtyProviderStartup?.() ?? options?.awaitLocalPtyStartup?.())
      : undefined
  }

  return { getLocalPtyStartupPromise, getLocalPtyProviderStartupPromise }
}
