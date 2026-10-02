// A send the CLI folds into the running request cycle: its adopted replay is a
// delivery receipt, never a new turn boundary. The provider's own cycle state
// decides — a root init announces each new cycle, and a result's
// `user_message_uuids` names every send the cycle ran. The measured miss, a
// lost result followed by a new cycle, and fresh replay uuids all keep the
// replay-driven opener path. Captured orders
// from Claude CLI 2.1.280 (`claude-captured-fold-steer-frames.test-fixture.ts`).

import { describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type {
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'
import {
  assistantText,
  initFrame,
  resultFrame,
  userReplay,
  type CapturedFoldFrame
} from './claude-fold-steer-frame-builders.test-fixture'
import {
  backgroundWakeCapture,
  cancelCapture,
  CANCEL_SEND_AT,
  earlySteerCapture,
  EARLY_STEER_SEND_AT,
  FIRST_PROMPT,
  foldFreshCapture,
  FOLD_FRESH_SEND_AT,
  foldResumedCapture,
  FOLD_RESUMED_SEND_AT,
  missCapture,
  MISS_SEND_AT,
  SECOND_STEER_PROMPT,
  STEER_PROMPT,
  twoSteersCapture,
  TWO_STEERS_SEND_AT
} from './claude-captured-fold-steer-frames.test-fixture'

const T0 = 1_700_000_100_000

type Rig = {
  adapter: ClaudeStructuredSessionAdapter
  claude: ReturnType<typeof fakeClaude>
  events: ClaudeStructuredSessionEvent[]
  settled: Mock
  /** Every revision of every turn lifecycle row, in append order. */
  turns: () => NonNullable<ReturnType<typeof readAgentJournalTurn>>[]
  deliver: (captured: CapturedFoldFrame) => void
  /** Dispatches at the captured send offset and returns the client uuid the CLI adopts. */
  dispatchAt: (at: number, clientMessageId: string, text: string) => Promise<string>
}

async function riggedAdapter(
  launch: Partial<ClaudeStructuredLaunch> = {},
  claudeOptions: Parameters<typeof fakeClaude>[0] = {}
): Promise<Rig> {
  let nowMs = T0
  const appended: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => appended.push({ identity, body }),
    appendTombstone: () => {},
    publish: () => {}
  }
  const events: ClaudeStructuredSessionEvent[] = []
  const settled = vi.fn()
  const claude = fakeClaude({ replayUuid: null, ...claudeOptions })
  const deps: ClaudeStructuredSessionAdapterDeps = {
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false,
      ...launch
    }),
    onEvent: (event) => events.push(event),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => T0 - 1_000,
    now: () => nowMs,
    persistHandle: async () => {},
    onDispatchSettledLate: settled
  }
  const adapter = new ClaudeStructuredSessionAdapter(deps)
  await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9', events: sink })
  await adapter.awaitStarted('session-1')
  return {
    adapter,
    claude,
    events,
    settled,
    turns: () =>
      appended.flatMap((item) => {
        const turn = readAgentJournalTurn(item.body)
        return turn ? [turn] : []
      }),
    deliver: (captured) => {
      nowMs = T0 + captured.at
      claude.connections[0]!.handlers.onMessage?.(captured.frame)
    },
    dispatchAt: async (at, clientMessageId, text) => {
      nowMs = T0 + at
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text }]
      }
      const outcome = await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId,
        body,
        requestedAt: nowMs,
        fence: 7
      })
      expect(outcome).toEqual({ state: 'admitted' })
      const sentUuid = claude.connections[0]!.sent.at(-1)?.uuid
      if (typeof sentUuid !== 'string') {
        throw new Error('the fake connection recorded no sent uuid')
      }
      return sentUuid
    }
  }
}

function replayEventFor(events: ClaudeStructuredSessionEvent[], uuid: string) {
  return events.find(
    (event) =>
      event.type === 'message' && event.message.type === 'user' && event.message.uuid === uuid
  )
}

describe('Claude fold receipt for a mid-turn send (captured orders)', () => {
  it('fold-fresh: the folded steer settles as a receipt inside the one turn it was sent during', async () => {
    const rig = await riggedAdapter()
    const first = await rig.dispatchAt(FOLD_FRESH_SEND_AT.first, 'client-first', FIRST_PROMPT)
    const framesFor = (steerUuid: string) =>
      foldFreshCapture({ sessionId: PROVIDER_SESSION_ID, first, steer: steerUuid })
    for (const captured of framesFor('pending')) {
      if (captured.at < FOLD_FRESH_SEND_AT.steer) {
        rig.deliver(captured)
      }
    }
    const steer = await rig.dispatchAt(FOLD_FRESH_SEND_AT.steer, 'client-steer', STEER_PROMPT)
    for (const captured of framesFor(steer)) {
      if (captured.at > FOLD_FRESH_SEND_AT.steer) {
        rig.deliver(captured)
      }
    }

    // ONE turn record for the whole run, never marked interrupted.
    const turnIds = [...new Set(rig.turns().map((turn) => turn.turnId))]
    expect(turnIds).toEqual([first])
    expect(rig.turns().every((turn) => turn.state !== 'interrupted')).toBe(true)
    // The settled duration is the single turn's, spanning both sends' work.
    expect(rig.turns().at(-1)).toMatchObject({
      turnId: first,
      state: 'completed',
      outcome: 'success',
      startedAt: T0 + 2_094,
      completedAt: T0 + 23_048,
      durationMs: 22_845
    })
    // The steer's replay is a receipt: delivery settles under the steer's own
    // provider identity, which is what attributes the user item inside the turn.
    expect(rig.settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-steer',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: steer }
    })
    // And it opens no boundary: the replay event carries no startsTurn.
    expect(replayEventFor(rig.events, steer)).not.toHaveProperty('startsTurn')
    expect(replayEventFor(rig.events, first)).toMatchObject({ startsTurn: true })
  })

  it('session-start proof: a hook-frame startup proof with init only at the first cycle still folds', async () => {
    // Live sessions prove the session from a SessionStart hook frame BEFORE
    // system/init arrives (measured against the real CLI); nothing about the
    // fold may depend on fields of the startup proof frame.
    const rig = await riggedAdapter({}, { initProof: 'session-start' })
    const first = await rig.dispatchAt(FOLD_FRESH_SEND_AT.first, 'client-first', FIRST_PROMPT)
    const framesFor = (steerUuid: string) =>
      foldFreshCapture({ sessionId: PROVIDER_SESSION_ID, first, steer: steerUuid })
    for (const captured of framesFor('pending')) {
      if (captured.at < FOLD_FRESH_SEND_AT.steer) {
        rig.deliver(captured)
      }
    }
    const steer = await rig.dispatchAt(FOLD_FRESH_SEND_AT.steer, 'client-steer', STEER_PROMPT)
    for (const captured of framesFor(steer)) {
      if (captured.at > FOLD_FRESH_SEND_AT.steer) {
        rig.deliver(captured)
      }
    }

    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([first])
    expect(rig.turns().every((turn) => turn.state !== 'interrupted')).toBe(true)
    expect(replayEventFor(rig.events, steer)).not.toHaveProperty('startsTurn')
  })

  it('fold-resumed: the receipt holds on a resumed provider session', async () => {
    const rig = await riggedAdapter({
      resumeLeafUuid: 'leaf-1',
      resumesTranscript: true,
      continuesChain: true
    })
    const first = await rig.dispatchAt(FOLD_RESUMED_SEND_AT.first, 'client-first', FIRST_PROMPT)
    const framesFor = (steerUuid: string) =>
      foldResumedCapture({ sessionId: PROVIDER_SESSION_ID, first, steer: steerUuid })
    for (const captured of framesFor('pending')) {
      if (captured.at < FOLD_RESUMED_SEND_AT.steer) {
        rig.deliver(captured)
      }
    }
    const steer = await rig.dispatchAt(FOLD_RESUMED_SEND_AT.steer, 'client-steer', STEER_PROMPT)
    for (const captured of framesFor(steer)) {
      if (captured.at > FOLD_RESUMED_SEND_AT.steer) {
        rig.deliver(captured)
      }
    }
    expect(rig.settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-steer',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: steer }
    })

    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([first])
    expect(rig.turns().every((turn) => turn.state !== 'interrupted')).toBe(true)
    expect(rig.turns().at(-1)).toMatchObject({
      turnId: first,
      state: 'completed',
      durationMs: 23_367
    })
  })

  it('two-steers: both folded sends settle individually inside the one turn', async () => {
    const rig = await riggedAdapter()
    const first = await rig.dispatchAt(TWO_STEERS_SEND_AT.first, 'client-first', FIRST_PROMPT)
    const framesFor = (steerUuid: string, secondSteerUuid: string) =>
      twoSteersCapture({
        sessionId: PROVIDER_SESSION_ID,
        first,
        steer: steerUuid,
        secondSteer: secondSteerUuid
      })
    for (const captured of framesFor('pending', 'pending-2')) {
      if (captured.at < TWO_STEERS_SEND_AT.steer) {
        rig.deliver(captured)
      }
    }
    // Both steers go out mid-turn, before the next captured frame at 7949.
    const steer = await rig.dispatchAt(TWO_STEERS_SEND_AT.steer, 'client-steer', STEER_PROMPT)
    const secondSteer = await rig.dispatchAt(
      TWO_STEERS_SEND_AT.secondSteer,
      'client-steer-2',
      SECOND_STEER_PROMPT
    )
    for (const captured of framesFor(steer, secondSteer)) {
      if (captured.at > TWO_STEERS_SEND_AT.secondSteer) {
        rig.deliver(captured)
      }
    }

    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([first])
    expect(rig.turns().every((turn) => turn.state !== 'interrupted')).toBe(true)
    expect(rig.settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-steer',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: steer }
    })
    expect(rig.settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-steer-2',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: secondSteer }
    })
  })

  it('early-steer: a steer written before the first replay arrives still folds into the one turn', async () => {
    const rig = await riggedAdapter()
    const first = await rig.dispatchAt(EARLY_STEER_SEND_AT.first, 'client-first', FIRST_PROMPT)
    const framesFor = (steerUuid: string) =>
      earlySteerCapture({ sessionId: PROVIDER_SESSION_ID, first, steer: steerUuid })
    for (const captured of framesFor('pending')) {
      if (captured.at < EARLY_STEER_SEND_AT.steer) {
        rig.deliver(captured)
      }
    }
    const steer = await rig.dispatchAt(EARLY_STEER_SEND_AT.steer, 'client-steer', STEER_PROMPT)
    for (const captured of framesFor(steer)) {
      if (captured.at > EARLY_STEER_SEND_AT.steer) {
        rig.deliver(captured)
      }
    }

    // No turn was open when the steer was written, and it still folded.
    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([first])
    expect(rig.turns().every((turn) => turn.state !== 'interrupted')).toBe(true)
    expect(rig.turns().at(-1)).toMatchObject({
      turnId: first,
      state: 'completed',
      durationMs: 7_155
    })
    expect(replayEventFor(rig.events, steer)).not.toHaveProperty('startsTurn')
    expect(rig.settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-steer',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: steer }
    })
  })

  it('background-wake: the wake cycle opens from its output and its result settles no waiter', async () => {
    const rig = await riggedAdapter()
    const first = await rig.dispatchAt(13, 'client-first', FIRST_PROMPT)
    const { firstTurn, wake } = backgroundWakeCapture({
      sessionId: PROVIDER_SESSION_ID,
      first,
      steer: 'unused'
    })
    for (const captured of [...firstTurn, ...wake]) {
      rig.deliver(captured)
    }

    // The task's completion revises a live row ahead of the wake's init, and
    // that provider output is what opens the wake turn.
    const finalByTurn = new Map(rig.turns().map((turn) => [turn.turnId, turn]))
    expect([...finalByTurn.keys()]).toEqual([first, 'task_updated-17547'])
    expect(finalByTurn.get('task_updated-17547')).toMatchObject({ state: 'completed' })
    // The wake result names no send; only the first send ever settled.
    expect(rig.settled).toHaveBeenCalledTimes(1)
  })

  it('background-wake: a steer replayed after the wake cycle began work folds into the wake turn', async () => {
    const rig = await riggedAdapter()
    const first = await rig.dispatchAt(13, 'client-first', FIRST_PROMPT)
    const { firstTurn, wake } = backgroundWakeCapture({
      sessionId: PROVIDER_SESSION_ID,
      first,
      steer: 'pending'
    })
    const wakeResult = wake.findIndex((captured) => captured.frame.type === 'result')
    for (const captured of [...firstTurn, ...wake.slice(0, wakeResult)]) {
      rig.deliver(captured)
    }
    // Captured order up to the wake's output; the steer's replay is placed
    // mid-cycle, where the CLI replays a send it folded (p3-early-steer).
    const steer = await rig.dispatchAt(19_725, 'client-steer', STEER_PROMPT)
    rig.deliver(userReplay(19_726, PROVIDER_SESSION_ID, steer, STEER_PROMPT))
    for (const captured of wake.slice(wakeResult)) {
      rig.deliver(captured)
    }

    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([
      first,
      'task_updated-17547'
    ])
    expect(rig.turns().every((turn) => turn.state !== 'interrupted')).toBe(true)
    expect(replayEventFor(rig.events, steer)).not.toHaveProperty('startsTurn')
    expect(rig.settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-steer',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: steer }
    })
  })

  it('mid-turn auto-compaction emits no root init, so a steer after the boundary still folds', async () => {
    // Measured (p4-autocompact, CLAUDE_CODE_AUTO_COMPACT_WINDOW forced): the
    // boundary is `status compacting` + `compact_boundary` + a synthetic
    // continuation user frame — and NO root init, so cycle work survives it.
    const rig = await riggedAdapter()
    const first = await rig.dispatchAt(14, 'client-first', FIRST_PROMPT)
    rig.deliver(initFrame(234, PROVIDER_SESSION_ID))
    rig.deliver(userReplay(2_437, PROVIDER_SESSION_ID, first, FIRST_PROMPT))
    rig.deliver(assistantText(2_864, PROVIDER_SESSION_ID, 'reply-1', 'reading files'))
    rig.deliver({
      at: 11_518,
      frame: {
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        session_id: PROVIDER_SESSION_ID,
        uuid: 'status-compacting-1'
      }
    })
    rig.deliver({
      at: 26_584,
      frame: {
        type: 'system',
        subtype: 'compact_boundary',
        session_id: PROVIDER_SESSION_ID,
        uuid: 'compact-boundary-1',
        compact_metadata: { trigger: 'auto', pre_tokens: 69_960, post_tokens: 9_311 }
      }
    })
    rig.deliver({
      at: 26_585,
      frame: {
        type: 'user',
        session_id: PROVIDER_SESSION_ID,
        parent_tool_use_id: null,
        uuid: 'continuation-1',
        isSynthetic: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'This session is being continued.' }]
        }
      }
    })
    const steer = await rig.dispatchAt(26_987, 'client-steer', STEER_PROMPT)
    rig.deliver(userReplay(34_601, PROVIDER_SESSION_ID, steer, STEER_PROMPT))
    rig.deliver(assistantText(37_824, PROVIDER_SESSION_ID, 'reply-2', 'FIRST DONE banana'))
    rig.deliver(
      resultFrame(37_828, PROVIDER_SESSION_ID, 'result-1', {
        userMessageUuids: [first, steer],
        durationMs: 37_616,
        numTurns: 6
      })
    )

    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([first])
    expect(rig.turns().every((turn) => turn.state !== 'interrupted')).toBe(true)
    expect(replayEventFor(rig.events, steer)).not.toHaveProperty('startsTurn')
    expect(rig.settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-steer',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: steer }
    })
  })

  it('miss: a steer whose replay trails the result keeps the opener path and its own turn', async () => {
    const rig = await riggedAdapter()
    const first = await rig.dispatchAt(MISS_SEND_AT.first, 'client-first', FIRST_PROMPT)
    const { beforeSteerSend } = missCapture({
      sessionId: PROVIDER_SESSION_ID,
      first,
      steer: 'pending'
    })
    for (const captured of beforeSteerSend) {
      rig.deliver(captured)
    }
    const steer = await rig.dispatchAt(MISS_SEND_AT.steer, 'client-steer', STEER_PROMPT)
    for (const captured of missCapture({ sessionId: PROVIDER_SESSION_ID, first, steer })
      .afterSteerSend) {
      rig.deliver(captured)
    }

    // Two real turns: the first completed by its result — not interrupted —
    // and the late steer's own turn opened by its replay.
    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([first, steer])
    expect(rig.turns().every((turn) => turn.state !== 'interrupted')).toBe(true)
    const finalByTurn = new Map(rig.turns().map((turn) => [turn.turnId, turn]))
    expect(finalByTurn.get(first)).toMatchObject({
      state: 'completed',
      completedAt: T0 + 25_556,
      durationMs: 25_241
    })
    expect(finalByTurn.get(steer)).toMatchObject({
      state: 'completed',
      startedAt: T0 + 28_703,
      completedAt: T0 + 29_275,
      durationMs: 3_711
    })
    expect(replayEventFor(rig.events, steer)).toMatchObject({ startsTurn: true })
  })

  it('cancel: a cancelled steer settles nothing and the receipt path changes none of it', async () => {
    const rig = await riggedAdapter()
    const first = await rig.dispatchAt(CANCEL_SEND_AT.first, 'client-first', FIRST_PROMPT)
    const { beforeSteerSend, afterInterrupt } = cancelCapture({
      sessionId: PROVIDER_SESSION_ID,
      first,
      steer: 'never-replayed'
    })
    for (const captured of beforeSteerSend) {
      rig.deliver(captured)
    }
    await rig.dispatchAt(CANCEL_SEND_AT.steer, 'client-steer', STEER_PROMPT)
    for (const captured of afterInterrupt) {
      rig.deliver(captured)
    }

    // One turn, ended by the interrupt's error result exactly as before.
    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([first])
    expect(rig.turns().at(-1)).toMatchObject({
      turnId: first,
      state: 'interrupted',
      outcome: 'cancellation'
    })
    // The steer was never replayed and its result never named it: no settlement.
    expect(rig.settled).not.toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: 'client-steer' })
    )
    // The interrupt's synthetic user text opens no turn either.
    expect(replayEventFor(rig.events, 'interrupt-notice-1')).not.toHaveProperty('startsTurn')
  })
})

describe('Claude fold receipt boundaries (synthetic orders)', () => {
  it('lost result: a root init starts a cycle with no work yet, so the next adopted replay is a boundary', async () => {
    const rig = await riggedAdapter()
    const uuidA = await rig.dispatchAt(10, 'client-a', 'first prompt')
    rig.deliver(userReplay(1_000, PROVIDER_SESSION_ID, uuidA, 'first prompt'))
    const uuidB = await rig.dispatchAt(1_500, 'client-b', STEER_PROMPT)
    // A's result never arrives, but the CLI announces its next request cycle:
    // the open turn stops folding, so B's replay opens its own turn.
    rig.deliver(initFrame(2_000, PROVIDER_SESSION_ID))
    rig.deliver(userReplay(3_000, PROVIDER_SESSION_ID, uuidB, STEER_PROMPT))

    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([uuidA, uuidB])
    expect(replayEventFor(rig.events, uuidB)).toMatchObject({ startsTurn: true })
  })

  it('provider wake: an adopted replay during the live wake cycle folds into the wake turn', async () => {
    // Cycle semantics: a wake is its own init-led cycle (p3-background-wake) and
    // a replay the CLI emits mid-cycle was folded into that cycle (p3-early-steer).
    const rig = await riggedAdapter()
    const uuidA = await rig.dispatchAt(10, 'client-a', 'first prompt')
    rig.deliver(userReplay(1_000, PROVIDER_SESSION_ID, uuidA, 'first prompt'))
    rig.deliver(
      resultFrame(2_000, PROVIDER_SESSION_ID, 'result-1', {
        userMessageUuids: [uuidA],
        durationMs: 1_990,
        numTurns: 1
      })
    )
    const uuidB = await rig.dispatchAt(2_500, 'client-b', STEER_PROMPT)
    rig.deliver(initFrame(3_000, PROVIDER_SESSION_ID))
    rig.deliver(assistantText(3_500, PROVIDER_SESSION_ID, 'provider-resumed-1', 'background done'))
    rig.deliver(userReplay(4_000, PROVIDER_SESSION_ID, uuidB, STEER_PROMPT))

    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([
      uuidA,
      'provider-resumed-1'
    ])
    expect(replayEventFor(rig.events, uuidB)).not.toHaveProperty('startsTurn')
    expect(rig.settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-b',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: uuidB }
    })
  })

  it('a fresh replay uuid with user_message_uuid correlation keeps the opener path, not a fold receipt', async () => {
    const rig = await riggedAdapter()
    const uuidA = await rig.dispatchAt(10, 'client-a', 'first prompt')
    rig.deliver(userReplay(1_000, PROVIDER_SESSION_ID, uuidA, 'first prompt'))
    const uuidB = await rig.dispatchAt(1_500, 'client-b', STEER_PROMPT)
    // A replay that did not adopt the client uuid is not the measured fold
    // shape, so it keeps the opener path it had before the receipt existed.
    const fresh = userReplay(2_000, PROVIDER_SESSION_ID, 'fresh-turn-2', STEER_PROMPT)
    rig.deliver({ ...fresh, frame: { ...fresh.frame, user_message_uuid: uuidB } })

    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([uuidA, 'fresh-turn-2'])
    expect(replayEventFor(rig.events, 'fresh-turn-2')).toMatchObject({ startsTurn: true })
    expect(rig.settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-b',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: 'fresh-turn-2' }
    })
  })

  it('plural result uuids: an unsettled folded waiter settles under its own uuid, never a shared result alias', async () => {
    const rig = await riggedAdapter()
    const uuidA = await rig.dispatchAt(10, 'client-a', 'first prompt')
    rig.deliver(userReplay(1_000, PROVIDER_SESSION_ID, uuidA, 'first prompt'))
    const uuidB = await rig.dispatchAt(1_500, 'client-b', STEER_PROMPT)
    // B's replay never arrives; the folded turn's one result still names it.
    rig.deliver(
      resultFrame(5_000, PROVIDER_SESSION_ID, 'result-1', {
        userMessageUuids: [uuidA, uuidB],
        durationMs: 4_990,
        numTurns: 2
      })
    )

    expect(rig.settled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientMessageId: 'client-b',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: uuidB }
    })
    expect(rig.settled).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerIdentity: expect.objectContaining({ uuid: 'result-1' }) })
    )
    // The correlated result opened nothing and the one turn completed normally.
    expect([...new Set(rig.turns().map((turn) => turn.turnId))]).toEqual([uuidA])
    expect(rig.turns().at(-1)).toMatchObject({ turnId: uuidA, state: 'completed' })
  })

  it('plural result uuids: a result naming only settled sends does not claim an unnamed live waiter by queue order', async () => {
    const rig = await riggedAdapter()
    const uuidA = await rig.dispatchAt(10, 'client-a', 'first prompt')
    rig.deliver(userReplay(1_000, PROVIDER_SESSION_ID, uuidA, 'first prompt'))
    await rig.dispatchAt(1_500, 'client-b', STEER_PROMPT)
    // A result that names only sends already settled must not fall back to
    // queue order and claim B, the still-live waiter it did not name.
    rig.deliver(
      resultFrame(5_000, PROVIDER_SESSION_ID, 'result-1', {
        userMessageUuids: [uuidA],
        durationMs: 4_990,
        numTurns: 1
      })
    )
    expect(rig.settled).not.toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: 'client-b' })
    )
  })
})
