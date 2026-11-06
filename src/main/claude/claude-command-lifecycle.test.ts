// Recorded CLI 2.1.280 lifecycle frames replay regardless of control-request success or loss.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { DISPATCH_REJECTED_CANCELLED } from '../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED } from '../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import { ClaudeStructuredSessionAdapter } from './structured/claude-structured-session-adapter'
import type { ClaudeLateDispatchOutcome } from './structured/claude-structured-session-state'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from './structured/claude-structured-session-test-support'
import { claudeStartupSettled } from './structured/claude-structured-startup-settled-test-support'

type CapturedEvent =
  | { kind: 'meta'; providerSessionId: string }
  | { kind: 'frame'; frame: Record<string, unknown> }
  | { kind: 'dispatch'; clientMessageId: string; sentUuid: string; text: string }
  | { kind: 'control'; request: Record<string, unknown> }
  | { kind: 'control-answer'; response: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeCapturedEvent(value: unknown): CapturedEvent {
  if (!isRecord(value)) {
    throw new Error('capture line is not a recorded event')
  }
  if (value.kind === 'meta' && typeof value.providerSessionId === 'string') {
    return { kind: 'meta', providerSessionId: value.providerSessionId }
  }
  if (value.kind === 'frame' && isRecord(value.frame)) {
    return { kind: 'frame', frame: value.frame }
  }
  if (
    value.kind === 'dispatch' &&
    typeof value.clientMessageId === 'string' &&
    typeof value.sentUuid === 'string' &&
    typeof value.text === 'string'
  ) {
    return {
      kind: 'dispatch',
      clientMessageId: value.clientMessageId,
      sentUuid: value.sentUuid,
      text: value.text
    }
  }
  if (value.kind === 'control' && isRecord(value.request)) {
    return { kind: 'control', request: value.request }
  }
  if (value.kind === 'control-answer' && isRecord(value.response)) {
    return { kind: 'control-answer', response: value.response }
  }
  throw new Error(`capture line has unknown kind: ${String(value.kind)}`)
}

function loadCapture(name: string): CapturedEvent[] {
  const path = join(__dirname, '__fixtures__', `claude-lifecycle-capture-${name}.jsonl`)
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => decodeCapturedEvent(JSON.parse(line)))
}

type Settlement = { sessionId: string } & ClaudeLateDispatchOutcome

type ControlPoint = {
  request: Record<string, unknown>
  /** Captured answer with UUIDs mapped to this replay. */
  answer: Record<string, unknown>
  deliverInFlight: () => void
  adapter: ClaudeStructuredSessionAdapter
  connection: FakeConnection
  routes: ReturnType<typeof fakeClaude>['routes']
  liveUuid: (clientMessageId: string) => string
}

async function replayCapture(
  name: string,
  options: {
    /** Defaults to replaying in-flight frames without a host control action. */
    atControl?: (point: ControlPoint) => Promise<void>
    /** Remove capabilities to simulate older CLIs. */
    withoutCapabilities?: string[]
    omitFrame?: (frame: Record<string, unknown>) => boolean
    /** Added frames use captured UUIDs. */
    afterFrame?: (frame: Record<string, unknown>) => Record<string, unknown>[]
    rewriteFrame?: (frame: Record<string, unknown>) => Record<string, unknown>
    /** Capture tails answer the CLI's original control request. */
    stopAfterControl?: boolean
  } = {}
) {
  const capture = loadCapture(name)
  const settlements: Settlement[] = []
  const turnStates = new Map<string, string>()
  const claude = fakeClaude({ initProof: 'none', replayUuid: null })
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      cliFlag: async () => 'supported' as const,
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1,
    now: () => 1_700_000_200_000,
    persistHandle: async () => {},
    onDispatchSettledLate: (settlement) => settlements.push(settlement)
  })
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: {
      appendItem: (_identity, body: AgentJournalItemBody) => {
        const turn = readAgentJournalTurn(body)
        if (turn) {
          turnStates.set(turn.turnId, turn.state)
        }
      },
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const connection = claude.connections[0]!

  const uuidMap = new Map<string, string>()
  const capturedSessionId = capture.flatMap((event) =>
    event.kind === 'meta' ? [event.providerSessionId] : []
  )[0]!
  const mapUuids = (value: Record<string, unknown>): Record<string, unknown> => {
    let text = JSON.stringify(value).replaceAll(capturedSessionId, PROVIDER_SESSION_ID)
    for (const [captured, live] of uuidMap) {
      text = text.replaceAll(captured, live)
    }
    const mapped: unknown = JSON.parse(text)
    if (!isRecord(mapped)) {
      throw new Error('mapped frame is not a record')
    }
    return mapped
  }
  const deliver = (frame: Record<string, unknown>): void => {
    if (options.omitFrame?.(frame)) {
      return
    }
    const mapped = mapUuids(options.rewriteFrame?.(frame) ?? frame)
    if (Array.isArray(mapped.capabilities) && options.withoutCapabilities) {
      mapped.capabilities = mapped.capabilities.filter(
        (capability) => !options.withoutCapabilities!.includes(String(capability))
      )
    }
    connection.handlers.onMessage?.(mapped)
    for (const extra of options.afterFrame?.(frame) ?? []) {
      connection.handlers.onMessage?.(mapUuids(extra))
    }
  }
  const liveUuid = (clientMessageId: string): string => {
    const dispatch = capture.find(
      (event) => event.kind === 'dispatch' && event.clientMessageId === clientMessageId
    )
    return dispatch?.kind === 'dispatch' ? (uuidMap.get(dispatch.sentUuid) ?? '') : ''
  }

  let proofDelivered = false
  for (let index = 0; index < capture.length; index++) {
    const event = capture[index]!
    if (event.kind === 'frame') {
      deliver(event.frame)
      proofDelivered = true
    } else if (event.kind === 'dispatch') {
      if (proofDelivered) {
        await claudeStartupSettled(adapter, 'session-1')
      }
      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId: event.clientMessageId,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: event.text }] },
          fence: 7
        })
      ).resolves.toMatchObject({ state: 'admitted' })
      uuidMap.set(event.sentUuid, String(connection.sent.at(-1)!.uuid))
    } else if (event.kind === 'control') {
      const answerAt = capture.findIndex(
        (candidate, at) => at > index && candidate.kind === 'control-answer'
      )
      if (answerAt === -1) {
        throw new Error('capture recorded no answer for its control request')
      }
      const inFlight = capture.slice(index + 1, answerAt)
      const answer = capture[answerAt]
      let delivered = false
      const deliverInFlight = (): void => {
        if (!delivered) {
          delivered = true
          for (const frameEvent of inFlight) {
            if (frameEvent.kind === 'frame') {
              deliver(frameEvent.frame)
            }
          }
        }
      }
      const atControl = options.atControl ?? (async (point) => point.deliverInFlight())
      await atControl({
        request: mapUuids(event.request),
        answer: answer?.kind === 'control-answer' ? mapUuids(answer.response) : {},
        deliverInFlight,
        adapter,
        connection,
        routes: claude.routes,
        liveUuid
      })
      deliverInFlight()
      if (options.stopAfterControl) {
        break
      }
      index = answerAt
    }
  }
  const settlementsFor = (clientMessageId: string) =>
    settlements
      .filter((settlement) => settlement.clientMessageId === clientMessageId)
      .map(({ sessionId: _sessionId, clientMessageId: _id, ...outcome }) => outcome)
  return { settlementsFor, turnStates, liveUuid, connection, adapter }
}

const WITHDRAWN = {
  state: 'rejected',
  unrun: true,
  reason: DISPATCH_REJECTED_CANCELLED,
  rejection: { kind: 'cancelled' }
}

function acceptedAs(uuid: string) {
  return { providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid } }
}

function stopWithInterruptAnswer(answer: 'recorded' | 'lost') {
  return async (point: ControlPoint): Promise<void> => {
    point.routes.interrupt = () => {
      point.deliverInFlight()
      if (answer === 'lost') {
        throw new ClaudeControlRequestError('interrupt', 'Control request timed out')
      }
      return point.answer
    }
    await point.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })
  }
}

describe('a Stop whose interrupt cancelled a queued follow-up (cancel_queued)', () => {
  it.each(['recorded', 'lost'] as const)(
    'withdraws the follow-up once when the interrupt answer is %s, and leaves the stopped turn’s message accepted',
    async (answer) => {
      const replay = await replayCapture('interrupt-lost', {
        atControl: stopWithInterruptAnswer(answer)
      })

      expect(replay.connection.calls.filter((call) => call.subtype === 'interrupt')).toEqual([
        { subtype: 'interrupt', params: { cancelQueued: true } }
      ])
      expect(replay.settlementsFor('client-B')).toEqual([WITHDRAWN])
      expect(replay.settlementsFor('client-A')).toEqual([acceptedAs(replay.liveUuid('client-A'))])
    }
  )
})

describe('a queued send the CLI withdraws without Orca hearing why', () => {
  it('withdraws only the batch lead; the send behind it runs as its own turn and is accepted', async () => {
    const replay = await replayCapture('batch-lead')

    expect(replay.settlementsFor('client-B')).toEqual([WITHDRAWN])
    expect(replay.settlementsFor('client-A')).toEqual([acceptedAs(replay.liveUuid('client-A'))])
    expect(replay.settlementsFor('client-C')).toEqual([acceptedAs(replay.liveUuid('client-C'))])
    expect([...replay.turnStates.entries()]).toEqual([
      [replay.liveUuid('client-A'), 'completed'],
      [replay.liveUuid('client-C'), 'completed']
    ])
  })
})

function isTurnOutput(frame: Record<string, unknown>): boolean {
  return frame.type === 'user' || frame.type === 'assistant' || frame.type === 'result'
}

function isLifecycleFrame(frame: Record<string, unknown>, state?: string): boolean {
  return frame.type === 'command_lifecycle' && (state === undefined || frame.state === state)
}

const ENDED_IN_DOUBT = { state: 'unknown', reason: DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED }

describe('a send the CLI started, then cancelled', () => {
  it('stays started when a redelivered command re-emits queued before its cancelled frame', async () => {
    const replay = await replayCapture('auth-failed', {
      omitFrame: isTurnOutput,
      afterFrame: (frame) =>
        isLifecycleFrame(frame, 'started') ? [{ ...frame, state: 'queued' }] : []
    })

    expect(replay.settlementsFor('client-A')).toEqual([ENDED_IN_DOUBT])
  })

  it('is still accepted when its echo lands after the doubt', async () => {
    const replay = await replayCapture('auth-failed', { omitFrame: isTurnOutput })
    const uuid = replay.liveUuid('client-A')

    replay.connection.handlers.onMessage?.({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'late echo' }] },
      parent_tool_use_id: null,
      session_id: PROVIDER_SESSION_ID,
      uuid
    })

    expect(replay.settlementsFor('client-A')).toEqual([ENDED_IN_DOUBT, acceptedAs(uuid)])
  })
})

describe('a send the CLI holds', () => {
  // CLI 2.1.280 can report idle before rereading its queue.

  it('holds the child for a send the CLI has only queued, and does not release it at idle', async () => {
    const replay = await replayCapture('auth-failed', {
      omitFrame: (frame) =>
        isTurnOutput(frame) ||
        isLifecycleFrame(frame, 'started') ||
        isLifecycleFrame(frame, 'cancelled')
    })

    expect(replay.adapter.holdsDispatch('session-1')).toBe(true)
    expect(replay.settlementsFor('client-A')).toEqual([])
  })
})
