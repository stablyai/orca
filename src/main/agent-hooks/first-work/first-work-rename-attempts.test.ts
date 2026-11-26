import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetFirstWorkBranchRenameState,
  startFirstWorkAttempt,
  waitForFirstWorkAttempt
} from './first-work-rename-attempts'

const ID = 'repo-1::/repo/barracuda-208'

describe('waitForFirstWorkAttempt', () => {
  beforeEach(() => resetFirstWorkBranchRenameState())

  it('hands a client the running attempt’s own result, and nothing once it is over', async () => {
    let finish!: () => void
    const started = startFirstWorkAttempt(
      ID,
      'incarnation',
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ outcome: { kind: 'failed' }, settles: false })
        }),
      { readIncarnation: () => 'incarnation' }
    )
    expect(waitForFirstWorkAttempt(ID, started.attemptId + 1)).toBeNull()
    const waited = waitForFirstWorkAttempt(ID, started.attemptId)
    finish()
    expect(await waited).toMatchObject({
      attemptId: started.attemptId,
      outcome: { kind: 'failed' }
    })
    expect(waitForFirstWorkAttempt(ID, started.attemptId)).toBeNull()
  })
})
