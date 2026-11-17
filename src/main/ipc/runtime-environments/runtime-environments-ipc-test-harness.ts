import { expect, type Mock } from 'vitest'

import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { createRuntimeEnvironmentStatusOwner } from './status/runtime-environment-status-owner'
import type { RuntimeHostStatusOwner } from '../../../shared/remote-runtime/host-status/runtime-host-status-owner'
import { isRuntimeEnvironmentManuallyDisconnected } from './connectivity/runtime-environment-manual-disconnect'

/** Keep IPC tests on the production owner while replacing only its transport. */
export function withRuntimeStatusOwners<T extends Record<string, Mock>>(transport: T) {
  const owners = new Map<string, RuntimeHostStatusOwner>()
  const ownerFor = (
    profile: string,
    environment: KnownRuntimeEnvironment
  ): RuntimeHostStatusOwner => {
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
            getPreferredPairedRuntimeConnection(environment)
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
  }
  return {
    ...transport,
    getRuntimeEnvironmentStatusOwner: async (profile: string, selector: string) =>
      ownerFor(profile, await resolveEnvironment(profile, selector)),
    withRuntimeEnvironmentStatusOwner: async <T>(
      profile: string,
      selector: string,
      consume: (environment: KnownRuntimeEnvironment, owner: RuntimeHostStatusOwner) => T
    ): Promise<T> => {
      const environment = await resolveEnvironment(profile, selector)
      return consume(environment, ownerFor(profile, environment))
    },
    getRuntimeEnvironmentStatusSnapshot: (environmentId: string) =>
      owners.get(environmentId)?.read() ?? null,
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

export function pairingCode(
  endpoint = 'ws://127.0.0.1:6768',
  { deviceToken = 'device-token', keyByte = 1 }: { deviceToken?: string; keyByte?: number } = {}
): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken,
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(keyByte)).toString('base64')
  })
}

export function channelHandlerLookup(handleMock: Mock) {
  return function handler<TArgs, TResult>(
    channel: string
  ): (_event: unknown, args: TArgs) => TResult | Promise<TResult> {
    const match = handleMock.mock.calls.find((call) => call[0] === channel)
    expect(match).toBeTruthy()
    return match![1] as (_event: unknown, args: TArgs) => TResult | Promise<TResult>
  }
}
