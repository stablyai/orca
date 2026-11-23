// Perf contract for #43145: a handover that keeps one raced send reads that attempt by key, not every
// recoverable attempt. Fails when the keyed lookup is reverted.
import { afterEach, expect, it, vi } from 'vitest'
import {
  fixture,
  failure,
  cleanUpInputRecoveryFixtures
} from './journal-domain-input-recovery.test-fixture'

afterEach(cleanUpInputRecoveryFixtures)

it.each([10, 100])(
  'reads one named attempt by key among %i pending ones, never walking every recoverable attempt',
  (pending) => {
    const f = fixture()
    for (let i = 0; i < pending; i++) {
      f.admit(`pending-${i}`)
    }
    const prepare = vi.spyOn(f.db, 'prepare')
    expect(
      f.recover({
        kind: 'queued-reject',
        fence: 1,
        rejection: failure,
        select: { only: { clientMessageId: 'pending-3', fence: 1 } }
      }).value
    ).toEqual({ value: ['pending-3'] })
    const recoveryReads = prepare.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /FROM journal_submission_attempts\s+INDEXED BY/.test(sql))
    prepare.mockRestore()
    expect(recoveryReads).toHaveLength(1)
    expect(recoveryReads[0]).toContain('journal_submission_head')
    expect(f.attempt('pending-4')?.submission.dispatchState).toBe('pending')
  }
)
