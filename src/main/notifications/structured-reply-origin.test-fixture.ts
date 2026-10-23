import type { StructuredReplyJournalSnapshot } from '../native-chat/agent-session-wire/structured-agent-session-reply-journal'
import { agentSessionSendBodyFingerprint } from '../../shared/structured-agent-session-send-mutation'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState
} from '../native-chat/agent-session-journal/journal-reducer'
import { parseJournalRow } from '../native-chat/agent-session-journal/journal-row-schema'

const EPOCH = 'epoch'
const TURN_ROW = 'legacy:claude:invented-session:turn-lifecycle%3Aturn-A'

/** `steered`: a program send opens the turn and this send is handed over into it. */
type ChatShape = 'claude' | 'codex' | 'steered' | 'claude-echo'

/** Persisted journal rows replayed through the production parser and reducer. The Claude rows
 *  mirror a captured composer send to Claude Code 2.1.301: the handed-over message stays in the
 *  thread and the turn names the provider item its dispatch accepted. The `codex` shape is
 *  hand-made on those rows, swapping in only the turn's submission-key userItemId; real Codex rows
 *  are covered by structured-agent-session-integration.test.ts. Ids and text are invented. */
export function replySnapshotFixture(
  source: 'user' | 'agent' | undefined,
  shape: ChatShape = 'claude'
): StructuredReplyJournalSnapshot {
  const rows: Record<string, unknown>[] = []
  const row = (fields: Record<string, unknown>, v = 2) =>
    rows.push({ v, epoch: EPOCH, seq: rows.length + 1, ts: rows.length + 1, ...fields })
  const providerItem = (send: string) =>
    shape === 'codex' ? `codex:invented-thread:turn-A:${send}` : `claude:invented-session:${send}`
  const submit = (send: string, kind: typeof source, turnScope: Record<string, unknown>) => {
    row({
      kind: 'submission',
      clientMessageId: send,
      payloadFingerprint: agentSessionSendBodyFingerprint('session', {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'invented input' }]
      }),
      providerHandle: { kind: 'opaque', agent: 'claude', value: 'pending' },
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'invented input' }] },
      fence: 1,
      handoverRecorded: true,
      origin: 'client',
      ...(kind ? { source: { kind } } : {})
    })
    row({
      kind: 'dispatch',
      clientMessageId: send,
      state: 'pending',
      providerItemId: null,
      reason: null,
      fence: 2,
      turnScope
    })
  }
  const accept = (send: string) =>
    row({
      kind: 'dispatch',
      clientMessageId: send,
      state: 'accepted',
      providerItemId: providerItem(send),
      reason: null,
      fence: 2
    })
  const turn = (state: 'running' | 'completed', userItemId: string) =>
    row(
      {
        kind: 'item',
        itemId: TURN_ROW,
        revision: state === 'running' ? 1 : 2,
        body: { kind: 'turn', turnId: 'turn-A', state, userItemId, startedAt: 1 },
        fence: 2,
        ownerFence: 2,
        turnScope: { kind: 'thread' }
      },
      3
    )
  row({
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'opaque', agent: 'claude', value: 'pending' },
    fence: 0
  })
  const starter = shape === 'steered' ? 'program' : 'send'
  submit(starter, shape === 'steered' ? 'agent' : source, { kind: 'thread' })
  const starterItem =
    shape === 'codex'
      ? agentJournalSubmissionKey(starter)
      : shape === 'claude-echo'
        ? providerItem('echo')
        : providerItem(starter)
  turn('running', starterItem)
  accept(starter)
  if (shape === 'claude-echo') {
    row(
      {
        kind: 'item',
        itemId: starterItem,
        revision: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'invented input' }] },
        fence: 2,
        ownerFence: 2,
        turnScope: { kind: 'thread' }
      },
      3
    )
  }
  if (shape === 'steered') {
    submit('send', source, { kind: 'turn', turnItemId: TURN_ROW })
    accept('send')
  }
  row(
    {
      kind: 'item',
      itemId: 'claude:invented-session:assistant',
      revision: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'invented' }] },
      fence: 2,
      ownerFence: 2,
      turnScope: { kind: 'turn', turnItemId: TURN_ROW }
    },
    3
  )
  turn('completed', starterItem)
  const state = createJournalReducerState('session', EPOCH)
  for (const value of rows) {
    const parsed = parseJournalRow(JSON.stringify(value))
    if (!parsed.ok) {
      throw new Error(`fixture journal row ${String(value.seq)} does not parse`)
    }
    applyJournalRow(state, parsed.row)
  }
  return { ...renderJournalState(state), aliases: new Map(state.aliases) }
}
