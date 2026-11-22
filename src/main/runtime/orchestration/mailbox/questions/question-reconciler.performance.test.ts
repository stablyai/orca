// Guards the agent-question reconciler (stablyai/orca PR "decide agent-question notices from who
// took them"): every chat status observation, terminal phase change and mail write reaches it, so
// with no question awaiting a notice it must touch the database not at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { noteQuestionEdge } from '../../db/messages/question-edges'
import { startRestingQuestionReconciler } from './question-reconciler.test-fixture'

describe('agent-question reconciler with nothing awaiting', () => {
  let db: OrchestrationDb
  let stop: () => void

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => {
    stop()
    db.close()
  })

  it('runs no statement for status observations, phase changes or mail', async () => {
    const started = startRestingQuestionReconciler(db, async () => () => 'told')
    stop = started.stop
    await started.reconciler.settled()
    const prepare = vi.spyOn(db.db, 'prepare')

    for (let i = 0; i < 100; i++) {
      started.reconciler.chatObserved(`session-${i}`, false)
      started.reconciler.terminalChanged(`terminal:term_${i}`, false)
      noteQuestionEdge({ kind: 'mail', ids: [`msg_${i}`] })
      noteQuestionEdge({ kind: 'mailbox', mailbox: `run:run_${i}` })
      noteQuestionEdge({ kind: 'pane', ptyId: `pty-${i}` })
      noteQuestionEdge({ kind: 'dispatch', id: `ctx_${i}` })
    }
    await new Promise((resolve) => setImmediate(resolve))
    await started.reconciler.settled()

    expect(prepare).toHaveBeenCalledTimes(0)
  })
})
