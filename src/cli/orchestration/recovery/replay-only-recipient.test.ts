import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_REPLAY_ONLY_RETRY_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { isRequestUnsent } from '../../runtime/connection/client-error-recovery'
import { replayOnlyRecipientCheck } from './replay-only-recipient'

describe('replayOnlyRecipientCheck', () => {
  const params = { type: 'worker_done' }

  it('sends the replay unchanged to a runtime that enforces replay-only', () => {
    const check = replayOnlyRecipientCheck(params)
    expect(
      check.paramsForStatus({ capabilities: [ORCHESTRATION_REPLAY_ONLY_RETRY_RUNTIME_CAPABILITY] })
    ).toBe(params)
  })

  it.each([
    ['an older runtime', { capabilities: ['orchestration.contract.v1'] }],
    ['a status without capabilities', {}],
    ['no status', undefined]
  ])('refuses %s before anything is sent', (_case, status) => {
    const check = replayOnlyRecipientCheck(params)
    let thrown: unknown
    try {
      check.paramsForStatus(status)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: 'retry_not_replayable',
      data: { reason: 'recipient_cannot_replay', effectsApplied: false }
    })
    expect(isRequestUnsent(thrown)).toBe(true)
  })
})
