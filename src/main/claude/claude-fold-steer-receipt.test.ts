// Replay orders captured from Claude CLI 2.1.280; synthetic boundary cases are labeled separately.

import { describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { ClaudeStructuredSessionAdapter } from './structured/claude-structured-session-adapter'
import type {
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './structured/claude-structured-session-state'
import type { ClaudeStructuredLaunch } from './structured/launch/claude-structured-launch-resolution'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './structured/claude-structured-session-test-support'
import { claudeStartupSettled } from './structured/claude-structured-startup-settled-test-support'
import {
  assistantText,
  initFrame,
  resultFrame,
  userReplay,
  type CapturedFoldFrame
} from './claude-fold-steer-frame-builders.test-fixture'
import {
  FIRST_PROMPT,
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
  turns: () => NonNullable<ReturnType<typeof readAgentJournalTurn>>[]
  deliver: (captured: CapturedFoldFrame) => void
  /** Dispatch at the capture offset and return the client UUID adopted by the CLI. */
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
      cliFlag: async () => 'supported' as const,
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
  await claudeStartupSettled(adapter, 'session-1')
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
      expect(outcome).toMatchObject({ state: 'admitted' })
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

  it('mid-turn auto-compaction emits no root init, so a steer after the boundary still folds', async () => {
    // Captured with forced auto-compaction (p4): compacting, boundary, and synthetic continuation have no root init.
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
})

describe('Claude fold receipt boundaries (synthetic orders)', () => {
  it('a fresh replay uuid with user_message_uuid correlation keeps the opener path, not a fold receipt', async () => {
    const rig = await riggedAdapter()
    const uuidA = await rig.dispatchAt(10, 'client-a', 'first prompt')
    rig.deliver(userReplay(1_000, PROVIDER_SESSION_ID, uuidA, 'first prompt'))
    const uuidB = await rig.dispatchAt(1_500, 'client-b', STEER_PROMPT)
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

  it('plural result uuids: a result naming only settled sends does not claim an unnamed live waiter by queue order', async () => {
    const rig = await riggedAdapter()
    const uuidA = await rig.dispatchAt(10, 'client-a', 'first prompt')
    rig.deliver(userReplay(1_000, PROVIDER_SESSION_ID, uuidA, 'first prompt'))
    await rig.dispatchAt(1_500, 'client-b', STEER_PROMPT)
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
