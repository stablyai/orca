import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'

const PANES: Record<string, string> = {
  term_lead: 'tab_a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  term_helper: 'tab_b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
}

describe('a reply names the message it answers', () => {
  let db: OrchestrationDb
  let dispatcher: RpcDispatcher
  let requests = 0

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService(null)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((h) => PANES[h] ?? null)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((h) => PANES[h] ?? null)
    runtime.setOrchestrationDb(db)
    dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  })
  afterEach(() => db.close())

  function reply(id: string, body: string) {
    requests += 1
    return dispatcher.dispatch({
      id: `reply_${requests}`,
      authToken: 'local',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `request_${requests}`,
      method: 'orchestration.reply',
      params: { id, body, from: 'term_helper' }
    })
  }

  it("names the ask it answers among several in one thread, though it lands in the Run's mailbox", async () => {
    const run = db.createRun({
      objective: 'Ship it',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: PANES.term_lead!
    })
    const ask = (subject: string, threadId?: string) =>
      db.insertMessage({
        from: 'term_lead',
        to: 'term_helper',
        subject,
        type: 'question',
        threadId,
        runId: run.id
      })
    const first = ask('Which branch?')
    const second = ask('Which port?', first.id)

    await expect(reply(second.id, '5173')).resolves.toMatchObject({ ok: true })
    await expect(reply(first.id, 'main')).resolves.toMatchObject({ ok: true })

    const replies = db.getAllMessagesForHandle(`run:${run.id}`)
    expect(replies.map((m) => [m.body, m.thread_id, m.reply_to]).sort()).toEqual([
      ['5173', first.id, second.id],
      ['main', first.id, first.id]
    ])
  })
})
