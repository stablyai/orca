// Replays of real Claude CLI 2.1.280 sessions (`__fixtures__/claude-lifecycle-capture-*.jsonl`)
// in which the CLI withdrew a queued send, interrupted a turn, or failed one. The recorded
// frames are the script; at each recorded control request the test decides how Orca's side of
// it went — the answer arriving, lost, or failing — and the CLI's own frames from while that
// request was outstanding are delivered either way.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { DISPATCH_REJECTED_CANCELLED } from '../../shared/structured-agent-session-dispatch-rejection'
import {
  DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED,
  DISPATCH_DOUBT_PROVIDER_IDLE
} from '../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import { claudeDispatchRejection } from './claude-structured-dispatch-content'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeLateDispatchOutcome } from './claude-structured-session-state'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from './claude-structured-session-test-support'

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
  /** The CLI's answer as recorded, mapped to this replay's uuids. */
  answer: Record<string, unknown>
  /** Delivers the frames the CLI emitted while the request was outstanding. */
  deliverInFlight: () => void
  adapter: ClaudeStructuredSessionAdapter
  connection: FakeConnection
  routes: ReturnType<typeof fakeClaude>['routes']
  liveUuid: (clientMessageId: string) => string
}

async function replayCapture(
  name: string,
  options: {
    /** What Orca did at the recorded control request; by default nothing (the CLI acted alone). */
    atControl?: (point: ControlPoint) => Promise<void>
    /** Drop these from the capture's init frames, as an older CLI would not advertise them. */
    withoutCapabilities?: string[]
    /** Leave out captured frames, to model a sequence the capture brackets. */
    omitFrame?: (frame: Record<string, unknown>) => boolean
    /** Frames to deliver right after a captured one, in the capture's own uuids. */
    afterFrame?: (frame: Record<string, unknown>) => Record<string, unknown>[]
    /** Deliver this in place of a captured frame, as a CLI reporting another state would. */
    rewriteFrame?: (frame: Record<string, unknown>) => Record<string, unknown>
    /** Stop after the control request settles; its tail answers the CLI's own control path. */
    stopAfterControl?: boolean
  } = {}
) {
  const capture = loadCapture(name)
  const settlements: Settlement[] = []
  const idles: string[] = []
  const turnStates = new Map<string, string>()
  // The capture supplies every frame, startup proof included.
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
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1,
    now: () => 1_700_000_200_000,
    persistHandle: async () => {},
    onDispatchSettledLate: (settlement) => settlements.push(settlement),
    onSessionIdle: ({ sessionId }) => idles.push(sessionId)
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

  // Captured uuids -> the uuids the live dispatches mint during this replay.
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
        await adapter.awaitStarted('session-1')
      }
      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId: event.clientMessageId,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: event.text }] },
          fence: 7
        })
      ).resolves.toEqual({ state: 'admitted' })
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
  return { settlementsFor, idles, turnStates, liveUuid, connection, adapter }
}

const WITHDRAWN = {
  state: 'rejected',
  reason: DISPATCH_REJECTED_CANCELLED,
  rejection: { kind: 'cancelled' }
}

function acceptedAs(uuid: string) {
  return { providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid } }
}

/** Orca's Stop with no turn named, as the chat sends it; the interrupt answers per `answer`. */
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
      // The interrupted turn's own message was echoed first; its later `cancelled` changes nothing.
      expect(replay.settlementsFor('client-A')).toEqual([acceptedAs(replay.liveUuid('client-A'))])
    }
  )

  it('ignores a cancelled frame for a send it no longer holds, or never sent', async () => {
    const replay = await replayCapture('interrupt-lost', {
      atControl: stopWithInterruptAnswer('lost')
    })
    for (const commandUuid of [
      replay.liveUuid('client-A'),
      replay.liveUuid('client-B'),
      '5a1b0c63-0000-4000-8000-000000000000'
    ]) {
      replay.connection.handlers.onMessage?.({
        type: 'command_lifecycle',
        command_uuid: commandUuid,
        state: 'cancelled',
        uuid: `lifecycle-${commandUuid}`,
        session_id: PROVIDER_SESSION_ID
      })
    }

    expect(replay.settlementsFor('client-A')).toEqual([acceptedAs(replay.liveUuid('client-A'))])
    expect(replay.settlementsFor('client-B')).toEqual([WITHDRAWN])
  })
})

describe('a Stop that withdraws the follow-up one at a time (no cancel_queued)', () => {
  it.each([
    [
      'times out',
      () => {
        throw new ClaudeControlRequestError('cancel_async_message', 'Control request timed out')
      }
    ],
    [
      'errors',
      () => {
        throw new Error('Query closed before response received')
      }
    ],
    ['answers false', () => false]
  ] as const)(
    'withdraws it from the CLI’s cancelled frame when cancel_async_message %s',
    async (_label, answer) => {
      const replay = await replayCapture('cancel-async', {
        withoutCapabilities: ['interrupt_cancel_queued_v1'],
        stopAfterControl: true,
        atControl: async (point) => {
          const queued = point.liveUuid('client-B')
          point.routes.interrupt = () => ({ still_queued: [queued] })
          point.routes.cancel_async_message = () => {
            point.deliverInFlight()
            return answer()
          }
          await point.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })
        }
      })

      expect(replay.connection.calls.map((call) => call.subtype)).toContain('cancel_async_message')
      expect(replay.settlementsFor('client-B')).toEqual([WITHDRAWN])
      expect(replay.settlementsFor('client-A')).toEqual([acceptedAs(replay.liveUuid('client-A'))])
    }
  )
})

describe('a queued send the CLI withdraws without Orca hearing why', () => {
  it('settles the withdrawn send from its own cancelled frame', async () => {
    const replay = await replayCapture('cancel-async')

    expect(replay.settlementsFor('client-B')).toEqual([WITHDRAWN])
    expect(replay.settlementsFor('client-A')).toEqual([acceptedAs(replay.liveUuid('client-A'))])
  })

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

/** The auth-failed capture's turn output: without it, its send started and got no echo. */
function isTurnOutput(frame: Record<string, unknown>): boolean {
  return frame.type === 'user' || frame.type === 'assistant' || frame.type === 'result'
}

function isLifecycleFrame(frame: Record<string, unknown>, state?: string): boolean {
  return frame.type === 'command_lifecycle' && (state === undefined || frame.state === state)
}

function isIdleFrame(frame: Record<string, unknown>): boolean {
  return frame.subtype === 'session_state_changed' && frame.state === 'idle'
}

/** The uuid a capture recorded for one of its sends, as its own frames name it. */
function capturedUuid(name: string, clientMessageId: string): string {
  const dispatch = loadCapture(name).find(
    (event) => event.kind === 'dispatch' && event.clientMessageId === clientMessageId
  )
  return dispatch?.kind === 'dispatch' ? dispatch.sentUuid : ''
}

const ENDED_IN_DOUBT = { state: 'unknown', reason: DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED }
const IDLE_IN_DOUBT = { state: 'unknown', reason: DISPATCH_DOUBT_PROVIDER_IDLE }

describe('a send the CLI started, then cancelled', () => {
  it('stays accepted when its turn failed after the echo', async () => {
    const replay = await replayCapture('auth-failed')

    expect(replay.settlementsFor('client-A')).toEqual([acceptedAs(replay.liveUuid('client-A'))])
  })

  it('is released as doubt, never withdrawn, when the cancelled frame came before any echo', async () => {
    const replay = await replayCapture('auth-failed', { omitFrame: isTurnOutput })

    expect(replay.settlementsFor('client-A')).toEqual([ENDED_IN_DOUBT])
    expect(replay.adapter.holdsDispatch('session-1')).toBe(false)
  })

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

  it.each(['discarded', 'refused'])(
    'is released as doubt when its turn ends %s after it started',
    async (state) => {
      const replay = await replayCapture('auth-failed', {
        omitFrame: isTurnOutput,
        rewriteFrame: (frame) =>
          isLifecycleFrame(frame, 'cancelled') ? { ...frame, state } : frame
      })

      expect(replay.settlementsFor('client-A')).toEqual([ENDED_IN_DOUBT])
    }
  )
})

// batch-lead's client-C is a steer: written while A's turn runs, queued, then started as its own
// turn once A completed. Its queued-while-Stopped case is interrupt-lost's client-B, above.
describe('a steer a Stop interrupts after it started', () => {
  it('is released as doubt, never withdrawn, when the Stop lands before its echo', async () => {
    const steer = capturedUuid('batch-lead', 'client-C')
    let started = false
    let routes: ControlPoint['routes'] | undefined
    const replay = await replayCapture('batch-lead', {
      atControl: async (point) => {
        routes = point.routes
        point.deliverInFlight()
      },
      // The Stop lands between the steer's start and its echo: nothing after its start arrives.
      omitFrame: () => started,
      afterFrame: (frame) => {
        started ||= isLifecycleFrame(frame, 'started') && frame.command_uuid === steer
        return []
      }
    })
    const uuid = replay.liveUuid('client-C')
    expect(replay.adapter.holdsDispatch('session-1')).toBe(true)

    // Answered as interrupt-lost's was, with nothing left queued; then that capture's tail for a
    // started command a Stop ended (its result dropped: one naming the steer would accept it).
    routes!.interrupt = () => ({ still_queued: [], cancelled: [] })
    await replay.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })
    for (const frame of [
      {
        type: 'command_lifecycle',
        command_uuid: uuid,
        state: 'cancelled',
        uuid: 'steer-cancelled'
      },
      { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'steer-idle' }
    ]) {
      replay.connection.handlers.onMessage?.({ ...frame, session_id: PROVIDER_SESSION_ID })
    }

    expect(replay.connection.calls.filter((call) => call.subtype === 'interrupt')).toEqual([
      { subtype: 'interrupt', params: { cancelQueued: true } }
    ])
    expect(replay.settlementsFor('client-C')).toEqual([ENDED_IN_DOUBT])
    expect(replay.adapter.holdsDispatch('session-1')).toBe(false)
  })
})

describe('a send the CLI ended before starting it', () => {
  it.each([
    // The CLI ended its session with the send still queued.
    ['discarded', 'notDelivered', false],
    // Declined before it queued, so no `queued` frame precedes it.
    ['refused', 'providerRejected', true]
  ] as const)('settles a %s send as not sent, saying why', async (state, kind, neverQueued) => {
    const followUp = capturedUuid('cancel-async', 'client-B')
    const replay = await replayCapture('cancel-async', {
      omitFrame: (frame) =>
        neverQueued && isLifecycleFrame(frame, 'queued') && frame.command_uuid === followUp,
      rewriteFrame: (frame) =>
        isLifecycleFrame(frame, 'cancelled') && frame.command_uuid === followUp
          ? { ...frame, state }
          : frame
    })

    expect(replay.settlementsFor('client-B')).toEqual([
      { state: 'rejected', ...claudeDispatchRejection(agentSessionFailureFact(kind)) }
    ])
    expect(replay.settlementsFor('client-A')).toEqual([acceptedAs(replay.liveUuid('client-A'))])
  })
})

describe('a send the CLI holds', () => {
  it('holds its child from the idle sweep until the CLI idles, then is released as doubt', async () => {
    // Started, then its turn threw: no echo and no terminal state, as the schema allows.
    const replay = await replayCapture('auth-failed', {
      omitFrame: (frame) =>
        isTurnOutput(frame) || isLifecycleFrame(frame, 'cancelled') || isIdleFrame(frame)
    })
    expect(replay.adapter.holdsDispatch('session-1')).toBe(true)
    expect(replay.settlementsFor('client-A')).toEqual([])

    replay.connection.handlers.onMessage?.({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      uuid: 'idle-after-throw',
      session_id: PROVIDER_SESSION_ID
    })

    expect(replay.settlementsFor('client-A')).toEqual([IDLE_IN_DOUBT])
    expect(replay.adapter.holdsDispatch('session-1')).toBe(false)
  })

  // 2.1.280's end-of-turn cleanup can report idle before it re-reads its queue.
  it('leaves a queued send the CLI idles before starting to open its turn and be accepted', async () => {
    const replay = await replayCapture('auth-failed', {
      afterFrame: (frame) =>
        isLifecycleFrame(frame, 'queued')
          ? [
              {
                type: 'system',
                subtype: 'session_state_changed',
                state: 'idle',
                uuid: 'idle-before-start',
                session_id: frame.session_id
              }
            ]
          : []
    })
    const uuid = replay.liveUuid('client-A')

    expect(replay.settlementsFor('client-A')).toEqual([acceptedAs(uuid)])
    expect(replay.turnStates.get(uuid)).toBe('completed')
  })

  it('holds the child for a send the CLI has only queued, and does not release it at idle', async () => {
    const replay = await replayCapture('auth-failed', {
      omitFrame: (frame) =>
        isTurnOutput(frame) ||
        isLifecycleFrame(frame, 'started') ||
        isLifecycleFrame(frame, 'cancelled')
    })

    expect(replay.idles).toEqual(['session-1'])
    expect(replay.adapter.holdsDispatch('session-1')).toBe(true)
    expect(replay.settlementsFor('client-A')).toEqual([])
  })

  it('holds a queued send until the CLI withdraws it', async () => {
    const held: boolean[] = []
    const replay = await replayCapture('cancel-async', {
      atControl: async (point) => {
        // The lead was echoed already; only the queued follow-up is left.
        held.push(point.adapter.holdsDispatch('session-1'))
        point.deliverInFlight()
        held.push(point.adapter.holdsDispatch('session-1'))
      }
    })

    expect(held).toEqual([true, false])
    expect(replay.settlementsFor('client-B')).toEqual([WITHDRAWN])
  })

  it('holds a queued send until it starts and is echoed', async () => {
    const held: boolean[] = []
    const replay = await replayCapture('batch-lead', {
      // Without its turn's end or the idle, only the start and echo can let it go.
      omitFrame: (frame) =>
        frame.type === 'result' || isLifecycleFrame(frame, 'completed') || isIdleFrame(frame),
      atControl: async (point) => {
        point.deliverInFlight()
        // The batch lead is withdrawn; the send behind it is only queued.
        held.push(point.adapter.holdsDispatch('session-1'))
      }
    })

    expect(held).toEqual([true])
    expect(replay.adapter.holdsDispatch('session-1')).toBe(false)
    expect(replay.settlementsFor('client-C')).toEqual([acceptedAs(replay.liveUuid('client-C'))])
  })

  it.each(['interrupt-lost', 'cancel-async', 'batch-lead', 'auth-failed'])(
    'holds nothing once the %s capture has run to its idle',
    async (name) => {
      const replay = await replayCapture(name)

      expect(replay.adapter.holdsDispatch('session-1')).toBe(false)
    }
  )
})

describe('the CLI reporting its session idle', () => {
  it.each(['interrupt-lost', 'cancel-async', 'batch-lead', 'auth-failed'])(
    'is reported once per idle frame (%s), never for running',
    async (name) => {
      const replay = await replayCapture(name)

      expect(replay.idles).toEqual(['session-1'])
    }
  )

  it('is not reported from a child the session no longer holds', async () => {
    const replay = await replayCapture('auth-failed')
    await replay.adapter.closeSession('session-1')

    replay.connection.handlers.onMessage?.({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      uuid: 'late-idle',
      session_id: PROVIDER_SESSION_ID
    })

    expect(replay.idles).toEqual(['session-1'])
  })
})
