import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_REPLY_METHOD } from './reply-method'
import { settleStructuredMailAttempt } from '../../../../orchestration/mailbox/structured-mail/structured-mail-custody'
import { startRestingQuestionReconciler } from '../../../../orchestration/mailbox/questions/question-reconciler.test-fixture'
import { testOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import type { BotRequestRecord } from '../../../../../bots/bot-request-view'
import type * as SessionTabs from '../../../../../bots/bot-session-tabs'
import { agentQuestionNotices } from './agent-question-notices'

// #50721: a question handed over as a pointer stays unread; once its asker is told it went
// unanswered, a later `check` must not hand it over again as new mail.

const PANES: Record<string, string> = {
  term_asker: 'tab_a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  term_taker: 'tab_b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
}
const TAKER_CHAT = testOrcaSessionId('00000000-0000-4000-8000-0000000000b0')

// Stubbed: only which agent owns the taker's chat.
vi.mock('../../../../../bots/bot-session-tabs', async (original) => ({
  ...(await original<typeof SessionTabs>()),
  botOfSession: (_bots: unknown, sessionId: string) =>
    sessionId === TAKER_CHAT ? { id: 'taker' } : null
}))

let db: OrchestrationDb
let runtime: OrcaRuntimeService

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  runtime = new OrcaRuntimeService(null)
  vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((h) => PANES[h] ?? null)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((h) => PANES[h] ?? null)
  runtime.setOrchestrationDb(db)
})
afterEach(() => db.close())

function askQuestion(): string {
  const runId = db.createRun({
    objective: 'o',
    coordinatorHandle: 'term_asker',
    coordinatorPaneKey: PANES.term_asker!
  }).id
  const record: BotRequestRecord = {
    fromBotId: 'asker',
    fromBotName: 'Asker',
    toBotId: 'taker',
    toBotName: 'Taker',
    purpose: 'question',
    depth: 1,
    askers: [],
    request: null,
    conversation: null
  }
  const admitted = db.admitBotRequest({
    rootKey: 'q',
    fromBotId: 'asker',
    toBotId: 'taker',
    purpose: 'question',
    depth: 1,
    record: JSON.stringify(record),
    message: { from: 'term_asker', to: 'term_taker', subject: 'Q', type: 'question', runId }
  })
  if (admitted.kind !== 'sent') {
    throw new Error(admitted.kind)
  }
  return admitted.message.id
}

/** The chat accepted a pointer to the mail, not the mail itself, so custody retires it unread. */
function handOverAsPointer(id: string): void {
  const row = {
    mailbox_handle: 'term_taker',
    message_id: id,
    session_id: TAKER_CHAT,
    operation_id: 'op-1',
    minted_at_ms: 1
  }
  db.reserveStructuredMailSend(row)
  settleStructuredMailAttempt(
    db,
    row,
    { epoch: '', state: { kind: 'accepted' }, body: null, withdrawal: 'unknown' },
    () => 'owed'
  )
}

it('does not hand a question told unanswered over again, and a late reply still lands', async () => {
  const { reconciler, stop } = startRestingQuestionReconciler(db, (taker, ids) =>
    agentQuestionNotices(runtime, taker, ids)
  )
  onTestFinished(stop)
  const id = askQuestion()
  handOverAsPointer(id)
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await reconciler.settled()
  }

  expect(db.getBotRequestOutcome(id)).toBe('unanswered')
  expect(db.getUnreadMessages('term_taker').map((m) => m.id)).not.toContain(id)

  // The taker's chat answers late, as `reply --id` does.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the reply handler reads.
  const context = {
    runtime,
    orchestrationCaller: {
      address: `orca_session_id:${TAKER_CHAT}`,
      terminalHandle: null,
      paneKey: null,
      orcaSessionId: TAKER_CHAT,
      sessionId: TAKER_CHAT,
      workspaceId: 'w'
    }
  } as unknown as RpcContext
  await ORCHESTRATION_REPLY_METHOD.handler({ id, body: 'late answer' }, context)
  expect(db.getBotRequestOutcome(id)).toBe('answered')
  // It reaches the asker's Run mailbox, after the unanswered notice.
  const asker = `run:${db.getMessageById(id)!.run_id}`
  expect(db.getUnreadMessages(asker).map((m) => m.body)).toContain('late answer')
})
