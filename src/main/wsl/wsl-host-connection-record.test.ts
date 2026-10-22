import { describe, expect, it } from 'vitest'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import { toWslHostStatus } from './wsl-host-connection-record'

const record: WslHostDeploymentRecord = {
  kind: 'wsl',
  distro: 'Ubuntu',
  localPort: 41_000,
  remotePort: 6_768,
  environmentId: 'wsl:ubuntu',
  createdAt: 1
}
const deferredUpdate = {
  candidateVersion: '1.5.0+ab',
  code: 'orcad_activation_policy_refused',
  reason: 'rolled back',
  forceable: true
}

describe('toWslHostStatus', () => {
  it('keeps the deferral of a connect that deferred, so Update and Force stay offered', () => {
    expect(
      toWslHostStatus(record, {
        state: 'failed',
        reason: 'rolled back',
        terminals: 'unverifiable',
        deferredUpdate
      }).deferredUpdate
    ).toEqual(deferredUpdate)
    expect(
      toWslHostStatus(record, { state: 'failed', reason: 'x', terminals: 'unverifiable' })
        .deferredUpdate
    ).toBeNull()
    expect(toWslHostStatus(record, { state: 'connecting' }).deferredUpdate).toBeNull()
  })
})
