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

  it('codes an unverifiable reason as a sentence, and keeps verbatim connect errors uncoded', () => {
    expect(
      toWslHostStatus(record, {
        state: 'unverifiable',
        reason: 'guest-unanswered',
        terminals: 'unverifiable'
      })
    ).toMatchObject({
      detail: 'The distro is running but didn’t answer Orca’s check.',
      detailCode: 'guestUnanswered'
    })
    const failed = toWslHostStatus(record, {
      state: 'failed',
      reason: 'bridge refused',
      terminals: 'unverifiable'
    })
    expect(failed.detail).toBe('bridge refused')
    expect(failed).not.toHaveProperty('detailCode')
    const pendingStop = {
      since: 1,
      reason: 'The WSL service did not confirm whether the distro runs.',
      reasonCode: 'serviceUnconfirmed',
      verdict: 'unverifiable' as const
    }
    expect(toWslHostStatus({ ...record, pendingStop }, { state: 'closed' })).toMatchObject({
      detail: pendingStop.reason,
      detailCode: 'serviceUnconfirmed',
      removalPending: true
    })
  })
})
