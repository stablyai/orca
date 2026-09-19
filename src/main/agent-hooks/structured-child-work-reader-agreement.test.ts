// Both surface projections read one committed revision of one collection, with no
// renderer in the process. This is the condition the atomic switch turns on.

import { describe, expect, it } from 'vitest'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-background-task-wire'
import {
  projectStructuredChildWorkBackgroundTaskState,
  projectStructuredChildWorkSubagents,
  structuredChildWorkCandidates
} from '../../shared/agent-status-child-work-structured-egress'
import { createStructuredChildWorkProducerFixture } from '../../shared/agent-status-child-work-structured-producer.test-fixture'

const ROSTER: AgentSessionBackgroundTaskState = {
  state: 'monitoring',
  tasks: [
    { id: 'task-agent', kind: 'agent', description: 'review', totalTokens: 40 },
    { id: 'task-shell', kind: 'command', description: 'build' }
  ],
  settledTasks: [{ id: 'task-old', kind: 'agent', state: 'done' }],
  supportsTaskStop: true
}

describe('the strip and the sidebar read one collection', () => {
  it('projects both surfaces from the same committed revision', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(ROSTER)
    const revision = producer.store.getSnapshot().revision

    const strip = projectStructuredChildWorkBackgroundTaskState(producer.store, producer.parent)
    const sidebar = projectStructuredChildWorkSubagents(producer.store, producer.parent)

    // Reading twice must not advance the store: these are selectors, not producers.
    expect(producer.store.getSnapshot().revision).toBe(revision)
    // The strip keeps all five kinds and the settled row; the sidebar keeps live agents.
    expect(strip?.tasks?.map((task) => task.id)).toEqual(['task-agent', 'task-shell'])
    expect(strip?.settledTasks?.map((task) => task.id)).toEqual(['task-old'])
    expect(sidebar?.map((row) => row.id)).toEqual(['task-agent'])

    // Both answer from the same records: every projected row is a canonical candidate.
    const canonical = structuredChildWorkCandidates(producer.store, producer.parent)
    expect(canonical.map((candidate) => candidate.providerId).sort()).toEqual([
      'task-agent',
      'task-old',
      'task-shell'
    ])
    for (const row of sidebar ?? []) {
      expect(canonical.some((candidate) => candidate.providerId === row.id)).toBe(true)
    }
  })

  it('moves both surfaces together when one child changes', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(ROSTER, 1_000)
    producer.publish(
      {
        ...ROSTER,
        tasks: [
          { id: 'task-agent', kind: 'agent', description: 'review', state: 'blocked' },
          { id: 'task-shell', kind: 'command', description: 'build' }
        ]
      },
      2_000
    )

    expect(projectStructuredChildWorkSubagents(producer.store, producer.parent)?.[0]?.state).toBe(
      'blocked'
    )
    expect(
      projectStructuredChildWorkBackgroundTaskState(producer.store, producer.parent)?.tasks?.[0]
        ?.state
    ).toBe('blocked')
  })

  it('reports no roster at all when the collection holds none for this parent', () => {
    const producer = createStructuredChildWorkProducerFixture()
    expect(
      projectStructuredChildWorkBackgroundTaskState(producer.store, producer.parent)
    ).toBeNull()
    expect(projectStructuredChildWorkSubagents(producer.store, producer.parent)).toBeUndefined()
  })
})

describe('a forgotten parent takes its children with it', () => {
  it('retires the whole subtree so no child outlives the session that owned it', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(ROSTER)
    expect(producer.children()).toHaveLength(3)

    expect(producer.store.applyMutation({ removeParent: producer.parent })).not.toBeNull()

    expect(producer.children()).toHaveLength(0)
    expect(producer.store.getAliasesForChild('child-1')).toEqual([])
    expect(projectStructuredChildWorkSubagents(producer.store, producer.parent)).toBeUndefined()
  })

  it('fences a late roster arriving after the parent was forgotten', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(ROSTER)
    producer.store.applyMutation({ removeParent: producer.parent })

    // Bookkeeping must not throw into the publication path; the refusal is reported.
    const outcome = producer.publish(ROSTER)

    expect(outcome.announced).toBe(0)
    expect(outcome.rejected.map((entry) => entry.reason)).toEqual(['invalid', 'invalid', 'invalid'])
    expect(producer.children()).toHaveLength(0)
  })

  it('frees the retired provider ids when the session is published again', () => {
    const producer = createStructuredChildWorkProducerFixture()
    producer.publish(ROSTER)
    const original = producer.childFor('task-agent')?.childWorkId
    producer.store.applyMutation({ removeParent: producer.parent })
    producer.store.applyMutation({ parent: { subject: producer.parent } })

    producer.publish(ROSTER)

    // A retired binding fences late observations for the lifetime it named; it is not a
    // permanent ban on the provider id, or a re-attached session would show no children
    // for as long as the tombstone is retained.
    const readmitted = producer.childFor('task-agent')
    expect(readmitted).not.toBeNull()
    expect(readmitted?.childWorkId).not.toBe(original)
    expect(readmitted?.invocation.generation).toBe(1)
    expect(producer.children()).toHaveLength(3)
    expect(projectStructuredChildWorkSubagents(producer.store, producer.parent)).toHaveLength(1)
  })
})
