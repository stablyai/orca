import { describe, expect, it } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionBackgroundTaskState } from '../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import type { AgentSessionCommandDetailTuple } from '../../../../../shared/agent-session/background-tasks/agent-session-command-details'
import type { Subscriber } from './agent-session-subscribe-input'
import {
  emitSubscriberFrame,
  type BackgroundTaskLaneRead,
  type SubscriberFieldHooks
} from './agent-session-subscriber-frame-fields'
import { republishSubscriberBackgroundTasks } from './agent-session-live-publications'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY } from '../../../../../shared/agent-session/background-tasks/agent-session-background-task-child-views-capability'
import { backgroundTaskSubscriberProjection } from '../../../../runtime/rpc/methods/structured-sessions/history/structured-agent-session-background-task-capability'

const TUPLE: AgentSessionCommandDetailTuple = {
  childWorkId: 'cmd',
  invocationId: 'cmd-run',
  generation: 1
}

function roster(available = true, description = 'pnpm test'): AgentSessionBackgroundTaskState {
  return {
    state: 'monitoring',
    children: [
      {
        id: 'cmd',
        kind: 'command',
        description,
        state: 'working',
        membership: 'live',
        firstObservedAt: 1,
        observedAt: 1,
        stoppable: true,
        invocation: { invocationId: 'cmd-run', generation: 1 }
      }
    ],
    ...(available ? { commandDetailsAvailable: [TUPLE] } : {})
  }
}

function subscriber(
  extra: Partial<Subscriber> = {}
): Subscriber & { sent: AgentSessionSubscribeEvent[] } {
  const sent: AgentSessionSubscribeEvent[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  return {
    id: 'sub',
    sessionId: 's',
    emit: (event) => sent.push(event),
    cursor: { epoch: 'e', sequence: 3 },
    fence: 1,
    boundedFrames: false,
    sent,
    ...extra
  } as Subscriber & { sent: AgentSessionSubscribeEvent[] }
}

function port(
  read: () => BackgroundTaskLaneRead | undefined,
  hooks: SubscriberFieldHooks = {}
): SubscriberDeliveryPort {
  const all: SubscriberFieldHooks = { ...hooks, readBackgroundTaskLane: () => read() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  return {
    hooks: all,
    emit: (target: Subscriber, event: AgentSessionSubscribeEvent) =>
      emitSubscriberFrame(all, target, event)
  } as unknown as SubscriberDeliveryPort
}

const opening = (
  state: AgentSessionBackgroundTaskState | null,
  fence = 1
): AgentSessionSubscribeEvent =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  ({
    type: 'snapshot',
    sessionId: 's',
    fence,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
    page: {} as never,
    backgroundTasks: state
  }) as AgentSessionSubscribeEvent

describe('credit placement (§H)', () => {
  it('is set at the one emission point for any roster-bearing frame, and cleared by an empty one', async () => {
    const reader = subscriber()
    await emitSubscriberFrame({}, reader, opening(roster(), 4))
    expect(reader.detailCredit).toBe(true)
    expect(reader.creditedFence).toBe(4)
    expect(reader.creditedRoster?.commandDetailsAvailable).toEqual([TUPLE])
    await emitSubscriberFrame({}, reader, {
      type: 'batch',
      sessionId: 's',
      fence: 4,
      batch: { cursor: reader.cursor, items: [], removedItemIds: [], submissions: [] },
      backgroundTasks: roster(false)
    })
    expect(reader.detailCredit).toBe(false)
    expect(reader.creditedRoster).toBeUndefined()
  })

  it('phones and legacy readers are projected before fingerprint and comparison, so they gain no credit', async () => {
    for (const ctx of [
      // A phone that declares child views still never reads exact commands.
      {
        clientKind: 'mobile' as const,
        clientCapabilities: [AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY]
      },
      { clientKind: 'mobile' as const, clientCapabilities: [] }
    ]) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
      const project = backgroundTaskSubscriberProjection(ctx as never)
      expect(project).toBeDefined()
      const reader = subscriber({ projectBackgroundTasks: project })
      await emitSubscriberFrame({}, reader, opening(roster(), 4))
      expect(reader.detailCredit).toBe(false)
      const fingerprint = reader.backgroundTasks
      // An availability-only change is the same frame for this reader: nothing is owed.
      await republishSubscriberBackgroundTasks(
        port(() => ({ kind: 'roster', fence: 4, state: roster(false) })),
        reader,
        's',
        1
      )
      expect(reader.sent).toHaveLength(1)
      expect(reader.backgroundTasks).toBe(fingerprint)
      expect(JSON.stringify(reader.sent)).not.toContain('commandDetailsAvailable')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
    expect(backgroundTaskSubscriberProjection({ clientKind: undefined } as never)).toBeUndefined()
  })
})

describe('lane emission rule (§H)', () => {
  it('present lane: a credited reader is sent a moved fence even when its rows are unchanged', async () => {
    const reader = subscriber()
    await emitSubscriberFrame({}, reader, opening(roster(), 4))
    await republishSubscriberBackgroundTasks(
      port(() => ({ kind: 'roster', fence: 5, state: roster() })),
      reader,
      's',
      1
    )
    expect(reader.sent).toHaveLength(2)
    expect(reader.sent[1]).toMatchObject({ type: 'batch', fence: 5 })
    expect(reader.creditedFence).toBe(5)
  })

  it('suppresses only an equal state at an equal fence', async () => {
    const reader = subscriber()
    await emitSubscriberFrame({}, reader, opening(roster(), 4))
    await republishSubscriberBackgroundTasks(
      port(() => ({ kind: 'roster', fence: 4, state: roster() })),
      reader,
      's',
      1
    )
    expect(reader.sent).toHaveLength(1)
    const uncredited = subscriber()
    await emitSubscriberFrame({}, uncredited, opening(roster(false), 4))
    await republishSubscriberBackgroundTasks(
      port(() => ({ kind: 'roster', fence: 9, state: roster(false) })),
      uncredited,
      's',
      1
    )
    expect(uncredited.sent).toHaveLength(1)
  })

  it('absent lane: replays the last sent rows with only availability re-derived', async () => {
    const reader = subscriber()
    await emitSubscriberFrame({}, reader, opening(roster(true, 'first rows'), 4))
    // A later snapshot changed the rows; the replay must start from these, not the first ones.
    await emitSubscriberFrame({}, reader, opening(roster(true, 'latest rows'), 4))
    await republishSubscriberBackgroundTasks(
      port(() => ({ kind: 'availability', fence: 4, keep: () => [] })),
      reader,
      's',
      1
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
    const replay = reader.sent.at(-1) as Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
    expect(replay.backgroundTasks?.children?.[0]?.description).toBe('latest rows')
    expect(replay.backgroundTasks).not.toHaveProperty('commandDetailsAvailable')
    expect(reader.detailCredit).toBe(false)
  })

  it('absent lane: a kept tuple at a moved fence is still sent; an unchanged one is not', async () => {
    const reader = subscriber()
    await emitSubscriberFrame({}, reader, opening(roster(), 4))
    await republishSubscriberBackgroundTasks(
      port(() => ({ kind: 'availability', fence: 4, keep: (tuples) => [...tuples] })),
      reader,
      's',
      1
    )
    expect(reader.sent).toHaveLength(1)
    await republishSubscriberBackgroundTasks(
      port(() => ({ kind: 'availability', fence: 6, keep: (tuples) => [...tuples] })),
      reader,
      's',
      1
    )
    expect(reader.sent).toHaveLength(2)
    expect(reader.sent[1]).toMatchObject({
      fence: 6,
      backgroundTasks: { commandDetailsAvailable: [TUPLE] }
    })
  })

  it('absent lane never reaches a reader without credit', async () => {
    const reader = subscriber()
    await emitSubscriberFrame({}, reader, opening(roster(false), 4))
    await republishSubscriberBackgroundTasks(
      port(() => ({ kind: 'availability', fence: 9, keep: () => [] })),
      reader,
      's',
      1
    )
    expect(reader.sent).toHaveLength(1)
  })
})
