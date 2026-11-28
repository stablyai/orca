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

describe('a reply to mail its sender has since followed up', () => {
  let db: OrchestrationDb
  let dispatcher: RpcDispatcher
  let runId: string
  let requests = 0

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService(null)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((h) => PANES[h] ?? null)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((h) => PANES[h] ?? null)
    runtime.setOrchestrationDb(db)
    dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    runId = db.createRun({
      objective: 'Ship it',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: PANES.term_lead!
    }).id
  })
  afterEach(() => db.close())

  const mail = (from: string, to: string, subject: string, threadId?: string) =>
    db.insertMessage({ from, to, subject, runId, threadId })

  async function replyWarnings(id: string) {
    requests += 1
    const response = await dispatcher.dispatch({
      id: `reply_${requests}`,
      authToken: 'local',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `request_${requests}`,
      method: 'orchestration.reply',
      params: { id, body: 'ok', from: 'term_helper' }
    })
    expect(response).toMatchObject({ ok: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: asserted ok above.
    const result = (response as { result: { warnings?: { code: string; message: string }[] } })
      .result
    return (result.warnings ?? []).filter((warning) => warning.code === 'superseded_reply')
  }

  it('still sends, and names newer mail on the same thread, read or unread', async () => {
    const stale = mail('term_lead', 'term_helper', 'Sign-in in progress')
    const newer = mail('term_lead', 'term_helper', 'Signed in', stale.id)
    db.markAsRead([newer.id], { kind: 'orca' })
    mail('term_lead', 'term_other', 'Mail to someone else')

    expect(await replyWarnings(stale.id)).toEqual([
      {
        code: 'superseded_reply',
        recipient: 'term_lead',
        message: `${newer.id} from term_lead on this thread is newer than the message you answered; read it with \`orca orchestration inbox --terminal term_helper --limit 1 --full\`, and send a correction if your reply no longer fits.`
      }
    ])
  })

  it('stays silent for newer mail on another thread, the other way, or already answered', async () => {
    const first = mail('term_lead', 'term_helper', 'Which branch?')
    mail('term_lead', 'term_helper', 'Which port?')
    mail('term_helper', 'term_lead', 'Mail the other way', first.id)
    mail('term_lead', 'term_other', 'Mail to someone else', first.id)
    const followUp = mail('term_lead', 'term_helper', 'Also, which remote?', first.id)

    expect(await replyWarnings(followUp.id)).toEqual([])
    expect(await replyWarnings(first.id)).toEqual([])
  })
})
