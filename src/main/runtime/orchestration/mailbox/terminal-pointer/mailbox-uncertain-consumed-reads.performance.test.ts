import { expect, it } from 'vitest'
import { UncertainMailboxReconciliation } from './mailbox-pointer-resume'

// One Run's retained uncertain claims on this terminal; the reads below consume other mail.
function reconciliation(claims: number) {
  const reads = { count: 0 }
  const rows = Array.from({ length: claims }, (_, index) => ({
    id: `msg_${index}`,
    to_handle: 'run:old',
    pointer_enter_pending: 3,
    pointer_process_incarnation: 'incarnation-1'
  }))
  const db = {
    getPendingMailboxPointerMessagesForPty: () => {
      reads.count += 1
      return rows
    }
  }
  const deps = {
    getDb: () => db,
    resolveSubmitTarget: () => ({ ptyId: 'pty-1', processIncarnation: 'incarnation-1' }),
    onDeliveryDecision: () => {}
  }
  const state = { flightForPty: () => undefined }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reconciliation reads only these members.
  const reconciler = new UncertainMailboxReconciliation(deps as never, state as never)
  return { reads, reconciler }
}

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

it('consuming reads of unrelated mail never recount retained uncertain claims', async () => {
  for (const [claims, consumingReads] of [
    [1_000, 100],
    [10_000, 1_000]
  ]) {
    const { reads, reconciler } = reconciliation(claims)
    reconciler.reconcile('pty-1')
    await flush()
    for (let read = 0; read < consumingReads; read++) {
      reconciler.reconcileConsumed('pty-1', ['term:current'])
      await flush()
    }
    expect(reads.count).toBe(1)
    reconciler.reconcileConsumed('pty-1', ['run:old'])
    await flush()
    expect(reads.count).toBe(2)
  }
})
