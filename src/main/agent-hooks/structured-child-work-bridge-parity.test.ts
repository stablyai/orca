// Parity gate: the host producer's legacy subagent egress against the renderer bridge's
// own projection code, not a restatement of it. `subagentSnapshotsFromTasks` is imported
// from the bridge's module, so a change there reddens this file.
//
// The bridge is still the only live producer of native-chat child rows. This gate is what
// the atomic switch needs before that writer can be turned off.

import { describe, expect, it } from 'vitest'
import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../shared/agent-session-background-task-wire'
import {
  AGENT_STATUS_MAX_SUBAGENTS,
  type AgentSubagentSnapshot
} from '../../shared/agent-status-types'
import { createStructuredChildWorkProducerFixture } from '../../shared/agent-status-child-work-structured-producer.test-fixture'
import { subagentSnapshotsFromTasks } from '../../shared/structured-session-legacy-subagent-projection'

function roster(tasks: AgentSessionBackgroundTask[]): AgentSessionBackgroundTaskState {
  return { state: 'monitoring', tasks, supportsTaskStop: true }
}

function agent(
  id: string,
  overrides: Partial<AgentSessionBackgroundTask> = {}
): AgentSessionBackgroundTask {
  return { id, kind: 'agent', startedAt: 5, ...overrides }
}

/** Compare the two projections field by field, holding `startedAt` aside: the bridge
 *  publishes the provider's own stamp (or `0`), the host publishes its `firstObservedAt`,
 *  and that difference is asserted on its own below. */
function withoutStartedAt(
  snapshots: AgentSubagentSnapshot[] | undefined
): Omit<AgentSubagentSnapshot, 'startedAt'>[] | undefined {
  return snapshots?.map(({ startedAt: _startedAt, ...rest }) => rest)
}

function compare(tasks: AgentSessionBackgroundTask[]): {
  bridge: AgentSubagentSnapshot[] | undefined
  host: AgentSubagentSnapshot[] | undefined
} {
  const producer = createStructuredChildWorkProducerFixture()
  producer.publish(roster(tasks))
  return { bridge: subagentSnapshotsFromTasks(tasks), host: producer.subagents() }
}

function expectParity(tasks: AgentSessionBackgroundTask[]): AgentSubagentSnapshot[] | undefined {
  const { bridge, host } = compare(tasks)
  expect(withoutStartedAt(host)).toEqual(withoutStartedAt(bridge))
  return host
}

describe('legacy subagent egress matches the renderer bridge', () => {
  it('admits only agent-kind rows while the other kinds stay canonical', () => {
    const tasks: AgentSessionBackgroundTask[] = [
      agent('task-agent', { description: 'review' }),
      { id: 'task-shell', kind: 'command', startedAt: 6 },
      { id: 'task-watch', kind: 'monitor', startedAt: 7 },
      { id: 'task-flow', kind: 'workflow', startedAt: 8 },
      { id: 'task-other', kind: 'unknown', startedAt: 9 }
    ]
    const host = expectParity(tasks)
    expect(host?.map((row) => row.id)).toEqual(['task-agent'])

    // Positive control: the rows the closed vocabulary drops are still in the collection,
    // so an empty subagent projection is a statement about the projection, not the store.
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster(tasks))
    expect(producer.children()).toHaveLength(5)
    // Ordered by first observation then provider id; these share a publication clock.
    expect(producer.backgroundTaskState()?.tasks?.map((task) => [task.id, task.kind])).toEqual([
      ['task-agent', 'agent'],
      ['task-flow', 'workflow'],
      ['task-other', 'unknown'],
      ['task-shell', 'command'],
      ['task-watch', 'monitor']
    ])
  })

  it.each([
    ['working', 'working'],
    ['monitoring', 'working'],
    [undefined, 'working'],
    ['done', 'idle'],
    ['idle', 'idle'],
    ['waiting', 'waiting'],
    ['blocked', 'blocked'],
    ['unverifiable', 'unverifiable']
  ] as const)('maps provider state %s to %s exactly as the bridge does', (state, expected) => {
    const host = expectParity([agent('task-1', state === undefined ? {} : { state })])
    expect(host?.[0]?.state).toBe(expected)
  })

  it('trims provider ids, and admits only non-blank ids of at most 64 characters', () => {
    const host = expectParity([
      agent('  task-padded  '),
      agent('   '),
      agent('x'.repeat(64)),
      agent('y'.repeat(65))
    ])
    expect(host?.map((row) => row.id)).toEqual(['task-padded', 'x'.repeat(64)])
  })

  it('caps accepted rows at AGENT_STATUS_MAX_SUBAGENTS with invalid rows interleaved', () => {
    for (const count of [31, 32, 33]) {
      const tasks: AgentSessionBackgroundTask[] = []
      for (let index = 0; index < count; index += 1) {
        // Interleaved rejects must not consume the cap.
        tasks.push({ id: `command-${index}`, kind: 'command', startedAt: index })
        tasks.push(agent(`agent-${String(index).padStart(2, '0')}`, { startedAt: index }))
      }
      const host = expectParity(tasks)
      expect(host).toHaveLength(Math.min(count, AGENT_STATUS_MAX_SUBAGENTS))
    }
  })

  it('never lets the bounded projection evict a canonical record', () => {
    const producer = createStructuredChildWorkProducerFixture()
    const tasks = Array.from({ length: 40 }, (_unused, index) =>
      agent(`agent-${String(index).padStart(2, '0')}`, { startedAt: index })
    )
    producer.publish(roster(tasks))
    expect(producer.subagents()).toHaveLength(AGENT_STATUS_MAX_SUBAGENTS)
    expect(producer.children()).toHaveLength(40)
  })

  it('settles rows the authoritative roster stopped listing, as the bridge drops them', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('task-1'), agent('task-2')]))
    producer.publish(roster([agent('task-1')]))

    expect(producer.subagents()?.map((row) => row.id)).toEqual(['task-1'])
    expect(subagentSnapshotsFromTasks([agent('task-1')])?.map((row) => row.id)).toEqual(['task-1'])
    // Membership moved; the record and its history did not disappear.
    const settled = producer.childFor('task-2')
    expect(settled).toMatchObject({ membership: 'settled', state: 'idle', outcome: 'unknown' })
  })
})

describe('the intentional timestamp improvement', () => {
  it('publishes host firstObservedAt where the bridge published the provider stamp', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('task-1', { startedAt: 5 })]), 4_242)
    expect(producer.subagents()?.[0]?.startedAt).toBe(4_242)
    expect(subagentSnapshotsFromTasks([agent('task-1', { startedAt: 5 })])?.[0]?.startedAt).toBe(5)
    // Provider timing is retained separately rather than overwritten.
    expect(producer.childFor('task-1')?.providerTiming).toEqual({ startedAt: 5 })
  })

  it('replaces the bridge’s `?? 0` with a real host observation', () => {
    const producer = createStructuredChildWorkProducerFixture()
    const task: AgentSessionBackgroundTask = { id: 'task-1', kind: 'agent' }
    producer.publish(roster([task]), 7_777)
    expect(subagentSnapshotsFromTasks([task])?.[0]?.startedAt).toBe(0)
    expect(producer.subagents()?.[0]?.startedAt).toBe(7_777)
    expect(producer.childFor('task-1')?.providerTiming).toBeUndefined()
  })

  it('keeps first-observation time stable across later updates', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('task-1')]), 1_000)
    producer.publish(roster([agent('task-1', { totalTokens: 12 })]), 9_000)
    expect(producer.subagents()?.[0]?.startedAt).toBe(1_000)
  })
})

describe('declared deviations from the bridge', () => {
  it('refuses a provider id carrying control characters that the bridge admits', () => {
    const task = agent('taskone')
    // The bridge only trims and length-checks, so it publishes the row.
    expect(subagentSnapshotsFromTasks([task])?.[0]?.id).toBe('taskone')
    // A canonical alias is a serialized key; a control character cannot be one.
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([task]))
    expect(producer.children()).toHaveLength(0)
    expect(producer.subagents()).toBeUndefined()
  })

  it('orders the bounded projection by first observation, not by current roster order', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('b-task'), agent('a-task')]), 1_000)
    // The provider reorders; the host keeps the order it first observed them in.
    producer.publish(roster([agent('a-task'), agent('b-task')]), 2_000)
    expect(producer.subagents()?.map((row) => row.id)).toEqual(['a-task', 'b-task'])
  })
})
