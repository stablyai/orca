import { expect } from 'vitest'
import type { Mock } from 'vitest'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { encodePairingOffer } from '../../shared/pairing'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { createRuntimeEnvironmentStatusOwner } from './runtime-environment-status-owner'
import type { RuntimeHostStatusOwner } from '../../shared/runtime-host-status-owner'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'

/** Keep IPC tests on the production owner while replacing only its transport. */
export function withRuntimeStatusOwners<T extends Record<string, Mock>>(transport: T) {
  const owners = new Map<string, RuntimeHostStatusOwner>()
  return {
    ...transport,
    getRuntimeEnvironmentStatusOwner: (profile: string, selector: string) => {
      const environment = resolveEnvironment(profile, selector)
      let owner = owners.get(environment.id)
      if (!owner || owner.read().retired) {
        owner = createRuntimeEnvironmentStatusOwner(profile, environment, {
          isReady: () =>
            transport.getRemoteRuntimeSharedControlDiagnostics?.(environment.id)?.state === 'ready',
          request: (signal) =>
            transport.sendRemoteRuntimeSharedControlRequest(
              environment.id,
              undefined,
              'status.get',
              undefined,
              15_000,
              undefined,
              signal
            ),
          establish: () => {
            transport.ensureRemoteRuntimeSharedControlConnection?.(
              environment.id,
              getPreferredPairingOffer(environment)
            )
            transport.reconnectRemoteRuntimeSharedControlConnection?.(environment.id)
          },
          pause: () => transport.pauseRemoteRuntimeSharedControlRetry?.(environment.id)
        })
        owners.set(environment.id, owner)
        if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
          owner.dispose()
        }
      }
      return owner
    },
    getRuntimeEnvironmentStatusSnapshots: () => [...owners.values()].map((owner) => owner.read()),
    resetRuntimeEnvironmentStatusOwners: () => {
      owners.forEach((owner) => owner.dispose())
      owners.clear()
    },
    closeRemoteRuntimeRequestConnection: (...args: unknown[]) => {
      owners.get(args[0] as string)?.dispose()
      owners.delete(args[0] as string)
      transport.closeRemoteRuntimeRequestConnection(...args)
    }
  }
}

export function pairingCode(endpoint = 'ws://127.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

/** Resolves the `ipcMain.handle` callback a suite registered for `channel`. */
export function channelHandlerLookup(handleMock: Mock) {
  return function handler<TArgs, TResult>(
    channel: string
  ): (_event: unknown, args: TArgs) => TResult | Promise<TResult> {
    const match = handleMock.mock.calls.find((call) => call[0] === channel)
    expect(match).toBeTruthy()
    return match![1] as (_event: unknown, args: TArgs) => TResult | Promise<TResult>
  }
}
