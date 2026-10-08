// Verbatim replay of FULL captures recorded through Orca's own adapter against
// the real CLI (`__fixtures__/claude-adapter-capture-*.jsonl`): every frame the
// adapter saw — hook proof, per-cycle init, command_lifecycle, session-state,
// stream events — in the recorded order, with the recorded dispatch points.
// The oracle is the provider's own membership fact: each result's
// `user_message_uuids` must equal the sends that settled into the turn that
// result closed. Nothing here asserts design internals, so a rule change or a
// CLI drift that breaks membership fails these tests whatever the mechanism.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type {
  ClaudeLateDispatchOutcome,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  claudeStartupSettled
} from './claude-structured-session-test-support'

type CapturedEvent =
  | { at: number; kind: 'meta'; providerSessionId: string }
  | { at: number; kind: 'frame'; frame: Record<string, unknown> }
  | { at: number; kind: 'dispatch'; clientMessageId: string; sentUuid: string; text: string }
  | { at: number; kind: 'end' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeCapturedEvent(value: unknown): CapturedEvent {
  if (!isRecord(value) || typeof value.at !== 'number' || typeof value.kind !== 'string') {
    throw new Error('capture line is not a recorded event')
  }
  if (value.kind === 'meta' && typeof value.providerSessionId === 'string') {
    return { at: value.at, kind: 'meta', providerSessionId: value.providerSessionId }
  }
  if (value.kind === 'frame' && isRecord(value.frame)) {
    return { at: value.at, kind: 'frame', frame: value.frame }
  }
  if (
    value.kind === 'dispatch' &&
    typeof value.clientMessageId === 'string' &&
    typeof value.sentUuid === 'string' &&
    typeof value.text === 'string'
  ) {
    return {
      at: value.at,
      kind: 'dispatch',
      clientMessageId: value.clientMessageId,
      sentUuid: value.sentUuid,
      text: value.text
    }
  }
  if (value.kind === 'end') {
    return { at: value.at, kind: 'end' }
  }
  throw new Error(`capture line has unknown kind: ${String(value.kind)}`)
}

function loadCapture(name: string): CapturedEvent[] {
  const path = join(__dirname, '__fixtures__', `claude-adapter-capture-${name}.jsonl`)
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => decodeCapturedEvent(JSON.parse(line)))
}

type Replay = {
  settled: Mock
  /** Final revision per turn id, in first-open order. */
  finalTurns: Map<string, NonNullable<ReturnType<typeof readAgentJournalTurn>>>
  everInterrupted: boolean
  /** Each result frame's `user_message_uuids`, mapped to live dispatch uuids. */
  resultMemberships: string[][]
  /** clientMessageId -> provider uuid its delivery settled under. */
  settledUuids: Map<string, string>
  /** Live dispatch uuid -> turn id its send landed in (turn open at settlement). */
  liveUuidByClient: Map<string, string>
}

async function replayCapture(name: string): Promise<Replay> {
  const capture = loadCapture(name)
  let nowMs = 1_700_000_200_000
  const finalTurns = new Map<string, NonNullable<ReturnType<typeof readAgentJournalTurn>>>()
  let everInterrupted = false
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body: AgentJournalItemBody) => {
      const turn = readAgentJournalTurn(body)
      if (turn) {
        finalTurns.set(turn.turnId, turn)
        everInterrupted ||= turn.state === 'interrupted'
      }
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  const settled = vi.fn<(input: { sessionId: string } & ClaudeLateDispatchOutcome) => void>()
  // The capture supplies every frame, startup proof included.
  const claude = fakeClaude({ initProof: 'none', replayUuid: null })
  const deps: ClaudeStructuredSessionAdapterDeps = {
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1,
    now: () => nowMs,
    persistHandle: async () => {},
    onDispatchSettledLate: settled
  }
  const adapter = new ClaudeStructuredSessionAdapter(deps)
  await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9', events: sink })

  // Captured uuids -> the uuids the live dispatches mint during this replay.
  const uuidMap = new Map<string, string>()
  const capturedSessionId = capture.flatMap((event) =>
    event.kind === 'meta' ? [event.providerSessionId] : []
  )[0]
  const mapFrame = (frame: Record<string, unknown>): Record<string, unknown> => {
    let text = JSON.stringify(frame)
    for (const [captured, live] of uuidMap) {
      text = text.replaceAll(captured, live)
    }
    if (capturedSessionId) {
      text = text.replaceAll(capturedSessionId, PROVIDER_SESSION_ID)
    }
    const mapped: unknown = JSON.parse(text)
    if (!isRecord(mapped)) {
      throw new Error('mapped frame is not a record')
    }
    return mapped
  }
  const resultMemberships: string[][] = []
  let startedAwaited = false
  for (const event of capture) {
    nowMs = 1_700_000_200_000 + event.at
    if (event.kind === 'dispatch') {
      if (!startedAwaited) {
        // The proof frames have been delivered by now; startup can settle.
        await claudeStartupSettled(adapter, 'session-1')
        startedAwaited = true
      }
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: event.text }]
      }
      const before = new Set(uuidMap.values())
      const outcome = await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: event.clientMessageId,
        body,
        requestedAt: nowMs,
        fence: 7
      })
      expect(outcome).toEqual({ state: 'admitted' })
      const sent = claude.connections[0]!.sent.at(-1)?.uuid
      if (typeof sent !== 'string' || before.has(sent)) {
        throw new Error('replay could not read the dispatched uuid')
      }
      uuidMap.set(event.sentUuid, sent)
    } else if (event.kind === 'frame') {
      const frame = mapFrame(event.frame)
      if (frame.type === 'result') {
        const members = Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : []
        resultMemberships.push(members.filter((m): m is string => typeof m === 'string'))
      }
      claude.connections[0]!.handlers.onMessage?.(frame)
    }
  }
  const settledUuids = new Map<string, string>()
  for (const [outcome] of settled.mock.calls) {
    if ('providerIdentity' in outcome && outcome.providerIdentity.provider === 'claude') {
      settledUuids.set(outcome.clientMessageId, outcome.providerIdentity.uuid)
    }
  }
  const liveUuidByClient = new Map<string, string>()
  for (const event of capture) {
    if (event.kind === 'dispatch') {
      liveUuidByClient.set(event.clientMessageId, uuidMap.get(event.sentUuid)!)
    }
  }
  return { settled, finalTurns, everInterrupted, resultMemberships, settledUuids, liveUuidByClient }
}

describe.each(['fold', 'early-steer', 'miss'])('adapter capture replay: %s', (name) => {
  it('keeps turn membership equal to each result’s user_message_uuids', async () => {
    const replay = await replayCapture(name)

    // One turn per result, each opened by that result's first member, and no
    // turn ever marked interrupted (no capture interrupts one).
    expect([...replay.finalTurns.keys()]).toEqual(
      replay.resultMemberships.map((members) => members[0])
    )
    expect(replay.everInterrupted).toBe(false)
    for (const turn of replay.finalTurns.values()) {
      expect(turn.state).toBe('completed')
    }

    // Every send settled accepted under a provider uuid named by exactly the
    // result whose turn it belongs to — the provider's membership fact.
    const allMembers = new Set(replay.resultMemberships.flat())
    for (const [clientMessageId, liveUuid] of replay.liveUuidByClient) {
      expect(replay.settledUuids.get(clientMessageId)).toBe(liveUuid)
      expect(allMembers.has(liveUuid)).toBe(true)
    }
    for (const [index, members] of replay.resultMemberships.entries()) {
      for (const member of members) {
        // A member of result i must not have opened any OTHER turn.
        const owner = [...replay.finalTurns.keys()].indexOf(member)
        if (owner !== -1) {
          expect(owner).toBe(index)
        }
      }
    }
  })
})
