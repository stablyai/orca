import { describe, expect, it } from 'vitest'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import { isRecoverableRemoteRuntimeConnectionError } from '../../shared/remote-runtime/remote-runtime-client-error-classification'
import { OrcadHostUnsupportedError } from '../orcad/orcad-host-unavailable'
import {
  OrcadManagedIdentityError,
  OrcadManagedPairingRejectedError
} from '../managed-server/lifecycle/orcad-managed-tunnel-identity'
import { OrcadManagedPairingRepairFailedError } from '../managed-server/lifecycle/orcad-managed-pairing-repair-failure'
import { retryableConnectFailure, settlingConnectFailure } from './wsl-host-connect-failure'
import {
  WslDistroNotRunningError,
  WslOrcadLaunchDeferredError
} from './wsl-orcad-connection-errors'

describe('retryableConnectFailure', () => {
  it('turns a connect failure on a running host into a retryable one the renderer recognises', () => {
    const failure = retryableConnectFailure('Ubuntu', new Error('orcad exited'))
    expect(failure).toBeInstanceOf(RemoteRuntimeClientError)
    expect(failure).toMatchObject({ code: 'remote_runtime_unavailable' })
    expect(isRecoverableRemoteRuntimeConnectionError({ message: String(failure) })).toBe(true)
  })

  // Why final: each waits on the user; retrying would run a full deploy per pane until the deadline.
  it.each([
    [
      'a deferred update',
      () =>
        new WslOrcadLaunchDeferredError({
          outcome: 'deferred',
          distro: 'Ubuntu',
          candidateVersion: '2.0.0',
          code: 'live-terminals',
          reason: 'Terminals are still running.',
          forceable: true
        })
    ],
    ['an unsupported distro', () => new OrcadHostUnsupportedError('WSL 1')],
    ['a stopped distro (no-boot refusal)', () => new WslDistroNotRunningError('Ubuntu')],
    ['a foreign server', () => new OrcadManagedIdentityError(6790, 'another key')],
    ['an unpaired server', () => new OrcadManagedPairingRejectedError('devices were reset')],
    ['a failed re-pair', () => new OrcadManagedPairingRepairFailedError('refused again')]
  ])('keeps %s final', (_label, make) => {
    const refusal = make()
    expect(retryableConnectFailure('Ubuntu', refusal)).toBe(refusal)
  })

  it('reports a host still settling after an exit as retryable', () => {
    const failure = settlingConnectFailure('Ubuntu')
    expect(failure).toMatchObject({ code: 'remote_runtime_unavailable' })
    expect(isRecoverableRemoteRuntimeConnectionError({ message: String(failure) })).toBe(true)
  })
})
