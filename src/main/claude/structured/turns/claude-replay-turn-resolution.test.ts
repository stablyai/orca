import { claudeDispatchIsSteer } from './claude-command-lifecycle'
import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { selectStructuredAgentSettledTurns } from '../../../../shared/agent-session/view/structured-agent-session-turn-timing'
import { structuredAgentSessionCommandTurn } from '../../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'
import { cancelClaudeStructuredTurn } from '../journal/claude-structured-prompt-ownership'
import { dispatchClaudeMessage } from '../launch/claude-structured-message-options'
import { deliverClaudeReplayFrame } from '../lifecycle/claude-structured-event-delivery'
import { retireWaiter, waitForReplay } from '../dispatch/claude-structured-dispatch-waiters'
import type {
  ClaudeDispatchWaiter,
  ClaudeLateDispatchOutcome,
  ClaudeSession
} from '../claude-structured-session-state'

const SESSION = '00000000-0000-4000-8000-00000000c1a0'
const SENT = 'ec94ea32-e87c-4cef-9ff1-be319d2e77a5'
const RESULT = '5bfd911d-c26b-4598-bc75-959a8a2fd86d'
const FOLLOW_UP = 'f9123a8b-15b2-49f3-a00c-135976b198f7'

const lifecycle = (state: string, uuid = SENT): Record<string, unknown> => ({
  type: 'command_lifecycle',
  command_uuid: uuid,
  state,
  session_id: SESSION
})

// Frames Claude Code 2.1.330 sent for a prompt stopped while its UserPromptSubmit hook ran, trimmed to what is read.
// The result precedes lifecycle `cancelled`; the reverse order would release the send in doubt instead.
const stopFrames: Record<string, unknown>[] = [
  lifecycle('queued'),
  lifecycle('started'),
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid: '86166d82-2504-4a44-8f86-c94a7c967db4'
  },
  {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: SESSION,
    uuid: RESULT,
    terminal_reason: 'aborted_streaming',
    user_message_uuid: SENT,
    user_message_uuids: [SENT]
  },
  lifecycle('cancelled')
]

function fixture(connection?: Partial<ClaudeSession['connection']>) {
  const writes: AgentJournalRenderItem[] = []
  const settled: ClaudeLateDispatchOutcome[] = []
  const receipts: { clientMessageId: string; fence: number; observedAt: number }[] = []
  const dispatchWaiters: ClaudeDispatchWaiter[] = []
  const translator = createClaudeJournalTranslator({
    steerAwaitingEcho: (kind) =>
      dispatchWaiters.some((waiter) =>
        kind === 'all' ? claudeDispatchIsSteer(waiter) : waiter.steers === true
      ),
    sink: {
      appendItem: (identity, body, options) => {
        writes.push({
          itemId: agentJournalItemKey(identity),
          body,
          observedAt: options.observedAt ?? 0,
          revision: 0,
          sequence: writes.length + 1,
          turnScope: options.turnScope
        })
      },
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: frame translation uses only this session's replay state and journal translator.
  const session = {
    providerSessionId: SESSION,
    fence: 3,
    dispatchSequence: 0,
    dispatchWaiters,
    retiredDispatchWaiters: [],
    childWork: { live: new Map([['task', { toolUseId: 'tool-1', backgrounded: false }]]) },
    reportedOptions: {},
    capabilities: [],
    connection,
    translator
  } as unknown as ClaudeSession
  const frame = (message: Record<string, unknown>, observedAt: number, current = true) =>
    deliverClaudeReplayFrame({
      session,
      sessionId: 'chat',
      message,
      observedAt,
      current,
      onReceived: (receipt) => receipts.push(receipt),
      onSettledLate: ({ sessionId: _chat, ...outcome }) => settled.push(outcome),
      emit: translator.handle
    })
  return {
    session,
    frame,
    settled,
    receipts,
    turns: () => writes.filter((item) => item.body.kind === 'turn'),
    rows: () => [...new Map(writes.map((item) => [item.itemId, item])).values()]
  }
}

const echo = (uuid: string, sentUuid = uuid) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
  parent_tool_use_id: null,
  session_id: SESSION,
  user_message_uuid: sentUuid,
  uuid
})

const output = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: '619f98bd-92b5-4a2e-bcdf-27ce4346562e'
}

it.each([true, false])(
  'keeps the start and real echo identity through pre-echo output (root init %s)',
  (rootInit) => {
    const f = fixture()
    waitForReplay(f.session, false, SENT, 'key', 'client-1', 1000)
    f.frame(lifecycle('queued'), 1500)
    expect(f.turns()).toEqual([])
    f.frame(lifecycle('started'), 2000)
    f.frame(lifecycle('started'), 2100)
    if (rootInit) {
      f.frame({ type: 'system', subtype: 'init', session_id: SESSION }, 2200)
    }
    f.frame(output, 3000)
    const echoedUuid = 'e798686a-cd6f-4eb6-8b9a-3e3584b34ad9'
    f.frame(echo(echoedUuid, SENT), 4000)

    expect(f.receipts).toEqual([{ clientMessageId: 'client-1', fence: 3, observedAt: 1500 }])
    expect(f.turns().map((item) => item.body)).toEqual([
      {
        kind: 'turn',
        turnId: SENT,
        state: 'running',
        userItemId: 'orca:client-1',
        requestedAt: 1000,
        startedAt: 2000
      }
    ])
    expect(f.settled).toEqual([
      {
        clientMessageId: 'client-1',
        providerIdentity: { provider: 'claude', sessionId: SESSION, uuid: echoedUuid }
      }
    ])
    expect(f.session.translator?.turnCycle.ownsLiveProviderCycle).toBe(true)
  }
)

it('leaves an echoed fold on the existing turn', () => {
  const f = fixture()
  waitForReplay(f.session, false, SENT, 'key', 'opener', 1000)
  f.frame(lifecycle('started'), 2000)
  f.frame(echo(SENT), 2500)
  const folded = 'c446ca04-5cac-4ac5-8fb8-7c08708fd5d9'
  waitForReplay(f.session, false, folded, 'key', 'folded', 3000)
  f.frame(echo(folded), 3500)
  f.frame(lifecycle('started', folded), 4000)
  expect(f.turns()).toHaveLength(1)
  expect(f.receipts).toEqual([{ clientMessageId: 'opener', fence: 3, observedAt: 2000 }])
})

it('opens a priority steer at its matched start after the parent ends', () => {
  const f = fixture()
  waitForReplay(f.session, false, SENT, 'key', 'opener', 1000)
  f.frame(lifecycle('started'), 2000)
  f.frame(echo(SENT), 2500)
  const { waiter } = waitForReplay(f.session, false, FOLLOW_UP, 'key', 'steer', 4500)
  waiter.steers = true
  f.frame(lifecycle('queued', FOLLOW_UP), 4750)
  f.frame({ type: 'result', subtype: 'success', uuid: RESULT, session_id: SESSION }, 5000)
  f.frame(output, 5500)
  f.frame(lifecycle('started', FOLLOW_UP), 6000)
  f.frame(output, 6500)
  f.frame(echo(FOLLOW_UP), 7000)
  expect(f.turns().map((item) => item.body)).toMatchObject([
    { turnId: SENT, state: 'running', startedAt: 2000 },
    { turnId: SENT, state: 'completed', startedAt: 2000 },
    { turnId: FOLLOW_UP, state: 'running', userItemId: 'orca:steer', startedAt: 6000 }
  ])
  expect(f.receipts).toEqual([
    { clientMessageId: 'opener', fence: 3, observedAt: 2000 },
    { clientMessageId: 'steer', fence: 3, observedAt: 4750 }
  ])
  expect(f.settled.at(-1)).toEqual({
    clientMessageId: 'steer',
    providerIdentity: { provider: 'claude', sessionId: SESSION, uuid: FOLLOW_UP }
  })
})

it.each([false, true])('keeps a steer in its open turn (cut-short step %s)', (cutShort) => {
  const f = fixture()
  waitForReplay(f.session, false, SENT, 'key', 'opener', 1000)
  f.frame(lifecycle('started'), 2000)
  f.frame(echo(SENT), 2500)
  const { waiter } = waitForReplay(f.session, false, FOLLOW_UP, 'key', 'steer', 3000)
  waiter.steers = true
  if (cutShort) {
    f.frame({ ...stopFrames[3], is_error: false }, 3500)
  }
  f.frame(lifecycle('started', FOLLOW_UP), 4000)
  f.frame(echo(FOLLOW_UP), 4500)
  expect(f.turns().map((item) => item.body)).toMatchObject([
    { turnId: SENT, state: 'running', startedAt: 2000 }
  ])
  expect(f.settled.at(-1)).toMatchObject({
    clientMessageId: 'steer',
    answeredInTurn: { via: 'steer', turn: { recordId: `turn-lifecycle:${SENT}` } }
  })
})

it('starts and can stop a plain follow-up when its parent ends during send preparation', async () => {
  let writtenPriority: unknown
  let interrupted = false
  const f = fixture({
    backgroundTask: async () => {
      f.frame({ type: 'result', subtype: 'success', uuid: RESULT, session_id: SESSION }, 4000)
      return true
    },
    send: async (message, authorize) => {
      await authorize?.()
      writtenPriority = message.priority
      f.frame(lifecycle('queued', FOLLOW_UP), 4500)
    },
    interrupt: async () => {
      interrupted = true
      return undefined
    }
  })
  waitForReplay(f.session, false, SENT, 'key', 'opener', 1000)
  f.frame(lifecycle('started'), 2000)
  f.frame(echo(SENT), 2500)
  f.frame(output, 3000)
  expect(f.session.translator?.openTurnHasInputWork).toBe(true)
  const parentScope = f.session.translator!.currentTurnScope()
  expect(parentScope.kind).toBe('turn')
  await dispatchClaudeMessage(
    f.session,
    {
      sessionId: 'chat',
      clientMessageId: 'follow-up',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Hello' }] },
      fence: 3,
      requestedAt: 3500,
      turnScope: parentScope
    },
    undefined
  )
  expect(writtenPriority).toBeUndefined()
  expect(claudeDispatchIsSteer(f.session.dispatchWaiters[0]!)).toBe(false)
  f.frame(lifecycle('started', FOLLOW_UP), 5000)
  f.frame(echo(FOLLOW_UP), 5500)
  f.frame({ ...output, uuid: '3a020300-f901-4791-930d-483e74e819d6' }, 6000)
  expect(f.session.dispatchWaiters).toEqual([])
  expect(f.turns().map((item) => item.body)).toMatchObject([
    { turnId: SENT, state: 'running', startedAt: 2000 },
    { turnId: SENT, state: 'completed', startedAt: 2000 },
    { turnId: FOLLOW_UP, state: 'running', startedAt: 5000 }
  ])
  expect(
    await cancelClaudeStructuredTurn({
      request: { sessionId: 'chat', fence: 3 },
      sessions: new Map([['chat', f.session]])
    })
  ).toEqual({ cancelled: true })
  expect(interrupted).toBe(true)
})

it.each(['started', 'echo', 'output'])('times compaction from provider %s evidence', (evidence) => {
  const f = fixture()
  const command = structuredAgentSessionCommandTurn('compact-send')
  f.session.translator!.beginCommand({
    ...command,
    clientMessageId: 'compact-send',
    providerSessionId: SESSION,
    sentUuid: SENT,
    running: { kind: 'turn', turnId: command.turnId, state: 'running', requestedAt: 1000 }
  })
  waitForReplay(f.session, true, SENT, 'key', 'compact-send', 1000)
  if (evidence === 'started') {
    f.frame(lifecycle('queued'), 1500)
  }
  expect(f.turns()).toEqual([])
  const first = {
    started: lifecycle('started'),
    echo: echo(SENT),
    output
  }[evidence]!
  f.frame(first, 2000)
  f.frame(output, 2500)
  if (evidence !== 'echo') {
    f.frame(echo(SENT), 3000)
  }
  f.frame({ type: 'system', subtype: 'compact_boundary', session_id: SESSION }, 3500)
  f.frame({ type: 'result', subtype: 'success', uuid: RESULT, session_id: SESSION }, 4000)
  expect(f.turns().map((item) => item.body)).toMatchObject([
    { turnId: 'compact:compact-send', state: 'running', startedAt: 2000 },
    { turnId: 'compact:compact-send', state: 'completed', startedAt: 2000, completedAt: 4000 }
  ])
})

it('ignores receipt and start evidence from retired and superseded dispatch attempts', () => {
  const f = fixture()
  const { waiter } = waitForReplay(f.session, false, SENT, 'key', 'retired', 1000)
  retireWaiter(f.session, waiter)
  f.frame(lifecycle('started'), 2000)

  const rebound = '91c6ca44-dd3d-40dd-b059-3c18f4c6440c'
  waitForReplay(f.session, false, rebound, 'key', 'rebound', 1000)
  f.frame(lifecycle('queued', rebound), 2500, false)
  f.frame(lifecycle('started', rebound), 3000, false)
  const stale = 'ea0b78b1-d411-4d2b-853a-ceca93caf2a0'
  waitForReplay(f.session, false, stale, 'key', 'stale', 2000)
  f.session.fence = 4
  f.frame(lifecycle('started', stale), 3500)
  expect(f.receipts).toEqual([])
  expect(f.turns()).toEqual([])
})

it('settles a dropped prompt as rejected and suppresses the already-opened turn duration', async () => {
  const f = fixture()
  const { promise } = waitForReplay(f.session, false, SENT, 'key', 'client-1', 1000)
  for (const [index, frame] of stopFrames.entries()) {
    f.frame(frame, 1000 * (index + 2))
  }
  expect(f.settled).toHaveLength(1)
  expect(f.settled[0]).toMatchObject({
    clientMessageId: 'client-1',
    state: 'rejected',
    unrun: true
  })
  expect(await promise).toBeNull()
  expect(f.turns().map((item) => item.body)).toMatchObject([
    { turnId: SENT, state: 'running', startedAt: 3000 },
    { turnId: SENT, state: 'interrupted', startedAt: 3000, completedAt: 5000 }
  ])
  expect(
    selectStructuredAgentSettledTurns(f.rows(), [
      {
        clientMessageId: 'client-1',
        fence: 3,
        payloadFingerprint: 'test',
        dispatchState: 'rejected',
        providerItemId: null,
        reason: 'cancelled',
        submittedAt: 1000,
        resolvedAt: 5000,
        writtenAt: 2000
      }
    ]).get('orca:client-1')
  ).toBeNull()
})
