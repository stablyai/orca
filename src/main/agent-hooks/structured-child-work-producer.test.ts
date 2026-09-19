// The adoption conditions the architecture review set for this producer, exercised
// through the real decoder, reconciler, admission API and authority store.

import { describe, expect, it } from 'vitest'
import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../shared/agent-session-background-task-wire'
import { authorizeAgentChildWorkStop } from '../../shared/agent-status-child-work-stop'
import { createAgentStatusStore } from '../../shared/agent-status-store'
import {
  createStructuredChildWorkProducerFixture,
  fixtureSubject
} from '../../shared/agent-status-child-work-structured-producer.test-fixture'

function roster(
  tasks: AgentSessionBackgroundTask[],
  overrides: Partial<AgentSessionBackgroundTaskState> = {}
): AgentSessionBackgroundTaskState {
  return { state: 'monitoring', tasks, supportsTaskStop: true, ...overrides }
}

function agent(
  id: string,
  overrides: Partial<AgentSessionBackgroundTask> = {}
): AgentSessionBackgroundTask {
  return { id, kind: 'agent', ...overrides }
}

describe('one child per logical task', () => {
  it('admits one child for duplicate producer evidence and re-announcement', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('task-1', { description: 'first' })]))
    producer.publish(roster([agent('task-1', { description: 'first' })]))
    producer.publish(roster([agent('task-1', { description: 'renamed' })]))

    expect(producer.children()).toHaveLength(1)
    expect(producer.mintedCount).toBe(1)
    expect(producer.childFor('task-1')).toMatchObject({
      childWorkId: 'child-1',
      description: 'renamed',
      membership: 'live'
    })
  })

  it('keeps one child when the same id arrives in both rosters at once', () => {
    const producer = createStructuredChildWorkProducerFixture()
    // A provider that lists an id as settled and live in one frame is stating it is live.
    producer.publish(roster([agent('task-1')], { settledTasks: [agent('task-1')] }))

    expect(producer.children()).toHaveLength(1)
    expect(producer.childFor('task-1')?.membership).toBe('live')
  })

  it('keeps the child id when an unknown task is positively reclassified', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([{ id: 'task-1', kind: 'unknown' }]))
    const provisional = producer.childFor('task-1')
    expect(provisional).toMatchObject({ childWorkId: 'child-1', kind: 'unknown' })

    producer.publish(roster([agent('task-1', { name: 'reviewer' })]))

    expect(producer.mintedCount).toBe(1)
    expect(producer.childFor('task-1')).toMatchObject({
      childWorkId: 'child-1',
      kind: 'agent',
      name: 'reviewer'
    })
    // The provisional kind's alias is retired rather than left answering for the row.
    expect(producer.store.getAliasesForChild('child-1').map((alias) => alias.kind)).toEqual([
      'agent'
    ])
  })
})

describe('distinct identities for proven distinct lifetimes', () => {
  it('gives a revived provider id a new invocation while keeping its logical id', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('task-1')]))
    producer.publish(roster([], { settledTasks: [agent('task-1', { state: 'done' })] }))
    expect(producer.childFor('task-1')).toMatchObject({
      membership: 'settled',
      invocation: { generation: 0 }
    })

    producer.publish(roster([agent('task-1')]))

    const revived = producer.childFor('task-1')
    expect(producer.mintedCount).toBe(1)
    expect(revived).toMatchObject({
      childWorkId: 'child-1',
      membership: 'live',
      invocation: { generation: 1 }
    })
    // The settled invocation is retained rather than overwritten.
    expect(revived?.previousInvocations).toEqual([
      { fence: expect.objectContaining({ generation: 0 }), outcome: 'unknown', settledAt: 1_002 }
    ])
  })

  it('does not join one provider id across parents or execution scopes', () => {
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const local = createStructuredChildWorkProducerFixture({ store })
    const remote = createStructuredChildWorkProducerFixture({
      store,
      parent: fixtureSubject({ executionHostId: 'ssh:second-host' }),
      idPrefix: 'remote'
    })
    local.publish(roster([agent('task-1')]))
    remote.publish(roster([agent('task-1')]))

    // Assert both resolved before comparing them: two undefineds would differ too.
    expect(local.childFor('task-1')?.childWorkId).toBe('child-1')
    expect(remote.childFor('task-1')?.childWorkId).toBe('remote-1')
    expect(store.getChildren(local.parent)).toHaveLength(1)
    expect(store.getChildren(remote.parent)).toHaveLength(1)
  })

  it('leaves another producer’s children alone', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('task-1')]))
    const foreign = producer.store.applyMutation({
      children: [
        {
          childWorkId: 'hook-child',
          parent: producer.parent,
          provider: 'claude',
          kind: 'agent',
          state: 'working',
          membership: 'live',
          firstObservedAt: 1,
          observedAt: 1,
          stoppable: false,
          invocation: { invocationId: 'hooks', generation: 0 },
          provenance: { source: 'hook', producerId: 'agent-hooks' }
        }
      ]
    })
    expect(foreign).not.toBeNull()

    // An empty roster settles this producer's rows and must not touch the hook's.
    producer.publish(roster([]))

    expect(producer.store.getChild('hook-child')).toMatchObject({ membership: 'live' })
    expect(producer.childFor('task-1')?.membership).toBe('settled')
  })
})

describe('identity survives restore and republication', () => {
  it('reconstructs the collection on restore without reminting children', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('task-1'), agent('task-2')]))
    const snapshot = producer.store.getSnapshot()

    const restored = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    expect(restored.applySnapshot(snapshot)).toBe(true)
    const afterRestart = createStructuredChildWorkProducerFixture({
      store: restored,
      withParent: false
    })
    afterRestart.publish(roster([agent('task-1'), agent('task-2')]), 5_000)

    expect(afterRestart.mintedCount).toBe(0)
    expect(
      afterRestart
        .children()
        .map((child) => child.childWorkId)
        .sort()
    ).toEqual(['child-1', 'child-2'])
    expect(afterRestart.childFor('task-1')?.firstObservedAt).toBe(1_001)
  })

  it('keeps background work alive across turns and a reset that leaves the roster intact', () => {
    const producer = createStructuredChildWorkProducerFixture()
    const live = roster([agent('task-1', { state: 'working' })])
    producer.publish(live, 1_000)
    // A new turn, and then a /clear: the provider roster still lists the task, so the
    // host has no evidence the work stopped.
    producer.publish(live, 2_000)
    producer.publish(live, 3_000)

    expect(producer.childFor('task-1')).toMatchObject({
      childWorkId: 'child-1',
      membership: 'live',
      firstObservedAt: 1_000
    })
  })
})

describe('invocation fencing', () => {
  it('refuses a stop addressed to a superseded invocation', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('task-1')]))
    const first = producer.childFor('task-1')
    expect(first).not.toBeNull()
    producer.publish(roster([], { settledTasks: [agent('task-1', { state: 'done' })] }))
    producer.publish(roster([agent('task-1')]))

    const stale = authorizeAgentChildWorkStop(producer.store, {
      parent: producer.parent,
      childWorkId: 'child-1',
      expectedFence: first!.invocation
    })
    expect(stale).toBeNull()

    const current = producer.childFor('task-1')!
    expect(
      authorizeAgentChildWorkStop(producer.store, {
        parent: producer.parent,
        childWorkId: 'child-1',
        expectedFence: current.invocation
      })
    ).toMatchObject({ childWorkId: 'child-1' })
  })

  it('refuses a stop for a row no provider can target, and for a settled row', () => {
    const producer = createStructuredChildWorkProducerFixture()
    // Codex publishes no `supportsTaskStop`; the host asserts nothing it cannot do.
    producer.publish({ state: 'monitoring', tasks: [agent('task-1')], supportsStopAll: false })
    const child = producer.childFor('task-1')!
    expect(child.stoppable).toBe(false)
    expect(
      authorizeAgentChildWorkStop(producer.store, {
        parent: producer.parent,
        childWorkId: child.childWorkId,
        expectedFence: child.invocation
      })
    ).toBeNull()

    const stoppable = createStructuredChildWorkProducerFixture()
    stoppable.publish(roster([agent('task-1')]))
    expect(stoppable.childFor('task-1')?.stoppable).toBe(true)
    stoppable.publish(roster([], { settledTasks: [agent('task-1', { state: 'done' })] }))
    const settled = stoppable.childFor('task-1')!
    expect(settled.stoppable).toBe(false)
    expect(
      authorizeAgentChildWorkStop(stoppable.store, {
        parent: stoppable.parent,
        childWorkId: settled.childWorkId,
        expectedFence: settled.invocation
      })
    ).toBeNull()
  })
})

describe('honest uncertainty and full evidence', () => {
  it('treats an authoritative empty roster as lost membership, never as an outcome', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('task-1')]))
    // `null` is the provider reporting no live work, not a lost connection.
    producer.publish(null)

    expect(producer.childFor('task-1')).toMatchObject({
      membership: 'settled',
      state: 'idle',
      outcome: 'unknown'
    })
    expect(producer.children()).toHaveLength(1)
  })

  it('separates a provider-reported terminal state from live membership', () => {
    const producer = createStructuredChildWorkProducerFixture()
    // A row the provider still lists is live work even when its own state reads done;
    // an idle reusable agent is not therefore settled.
    producer.publish(
      roster([agent('task-1', { state: 'done' }), agent('task-2', { state: 'idle' })])
    )

    expect(producer.childFor('task-1')).toMatchObject({ membership: 'live', state: 'done' })
    expect(producer.childFor('task-2')).toMatchObject({ membership: 'live', state: 'idle' })
    expect(producer.childFor('task-1')?.outcome).toBeUndefined()
  })

  it('retains usage, settled history and stop capability before any projection', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(
      roster([agent('task-live', { totalTokens: 1_200, description: 'live work' })], {
        settledTasks: [agent('task-done', { state: 'done', totalTokens: 90 })],
        supportsStopAll: false
      })
    )

    expect(producer.childFor('task-live')?.totalTokens).toBe(1_200)
    expect(producer.childFor('task-done')).toMatchObject({ membership: 'settled', totalTokens: 90 })
    const projected = producer.backgroundTaskState()
    expect(projected?.tasks?.map((task) => task.id)).toEqual(['task-live'])
    expect(projected?.settledTasks?.map((task) => task.id)).toEqual(['task-done'])
    expect(projected).toMatchObject({ supportsTaskStop: true, supportsStopAll: false })
    // The summary drops usage on purpose; the collection does not.
    expect(projected?.tasks?.[0]?.totalTokens).toBe(1_200)
  })

  it('advances a child on a usage-only change that leaves the summary equal', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(roster([agent('task-1', { totalTokens: 10 })]), 1_000)
    const before = producer.childFor('task-1')!
    producer.publish(roster([agent('task-1', { totalTokens: 20 })]), 2_000)
    const after = producer.childFor('task-1')!

    expect(after.totalTokens).toBe(20)
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after.childWorkId).toBe(before.childWorkId)
  })

  it('refuses children for a parent the store does not hold', () => {
    const producer = createStructuredChildWorkProducerFixture({ withParent: false })
    const outcome = producer.publish(roster([agent('task-1')]))

    expect(outcome.announced).toBe(0)
    expect(outcome.rejected).toEqual([{ providerTaskId: 'task-1', reason: 'invalid' }])
    expect(producer.children()).toHaveLength(0)
  })
})
