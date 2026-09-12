import { describe, expect, it } from 'vitest'
import type { AdmissionPolicy } from './collaboration-admission'
import {
  admissionPolicyForTask,
  admittedPublishOptionsForTopic,
  allowedPublishTopicsForTask,
  createCollaborationTopology,
  requiredPublishTopicsForTask,
  subscribersForTopic,
  type CollaborationTopologyStep
} from './collaboration-topology'

const policy = (overrides: Partial<AdmissionPolicy> = {}): AdmissionPolicy => ({
  acceptedTypes: ['status'],
  minPriority: 'normal',
  ...overrides
})

const step = (overrides: Partial<CollaborationTopologyStep> = {}): CollaborationTopologyStep => ({
  taskId: 'task-a',
  ...overrides
})

describe('createCollaborationTopology', () => {
  it('throws on empty steps', () => {
    expect(() => createCollaborationTopology([])).toThrow()
  })

  it('throws on taskIds that are empty after trimming, without normalizing', () => {
    expect(() => createCollaborationTopology([step({ taskId: '' })])).toThrow(/taskId/)
    expect(() => createCollaborationTopology([step({ taskId: '   ' })])).toThrow(/taskId/)
  })

  it('preserves the original taskId string without trimming', () => {
    const topology = createCollaborationTopology([step({ taskId: '  task-a  ' })])
    expect(topology.steps[0].taskId).toBe('  task-a  ')
  })

  it('throws on duplicate taskIds', () => {
    expect(() =>
      createCollaborationTopology([step({ taskId: 'a' }), step({ taskId: 'a' })])
    ).toThrow(/duplicate/)
  })

  it('dedupes publishesTo preserving first occurrence order', () => {
    const topology = createCollaborationTopology([
      step({ taskId: 'a', publishesTo: ['t1', 't2', 't1', 't3'] })
    ])
    expect(topology.steps[0].publishesTo).toEqual(['t1', 't2', 't3'])
  })

  it('dedupes subscribesTo preserving first occurrence order', () => {
    const topology = createCollaborationTopology([
      step({ taskId: 'a', subscribesTo: ['t3', 't1', 't3', 't2'], admission: policy() })
    ])
    expect(topology.steps[0].subscribesTo).toEqual(['t3', 't1', 't2'])
  })

  it('throws when subscribesTo is non-empty and admission is missing', () => {
    expect(() =>
      createCollaborationTopology([step({ taskId: 'a', subscribesTo: ['t1'] })])
    ).toThrow(/admission/)
  })

  it('allows subscribing steps with an admission policy', () => {
    const topology = createCollaborationTopology([
      step({ taskId: 'a', subscribesTo: ['t1'], admission: policy() })
    ])
    expect(topology.steps[0].subscribesTo).toEqual(['t1'])
  })

  it('copies arrays and objects instead of retaining caller references', () => {
    const publishesTo = ['t1', 't2']
    const subscribesTo = ['t1']
    const admission = policy()
    const topology = createCollaborationTopology([
      step({ taskId: 'a', publishesTo, subscribesTo, admission })
    ])
    const copied = topology.steps[0]
    expect(copied.publishesTo).not.toBe(publishesTo)
    expect(copied.subscribesTo).not.toBe(subscribesTo)
    expect(copied.admission).not.toBe(admission)

    ;(publishesTo as string[]).push('t9')
    ;(subscribesTo as string[]).push('t9')
    ;(admission.acceptedTypes as string[]).push('t9')
    expect(topology.steps[0].publishesTo).toEqual(['t1', 't2'])
    expect(topology.steps[0].subscribesTo).toEqual(['t1'])
    expect(topology.steps[0].admission?.acceptedTypes).toEqual(['status'])
  })

  it('rejects a required topic not present in the same step publishesTo', () => {
    expect(() =>
      createCollaborationTopology([
        step({ taskId: 'a', publishesTo: ['t1', 't2'], requiredPublishesTo: ['t1', 't3'] }),
        step({ taskId: 'b', subscribesTo: ['t1', 't2'], admission: policy() })
      ])
    ).toThrow(/does not publish.*t3|t3.*does not publish/)
    expect(() =>
      createCollaborationTopology([step({ taskId: 'a', requiredPublishesTo: ['t1'] })])
    ).toThrow(/requiredPublishesTo|does not publish/)
  })

  it('rejects a required topic with no subscriber anywhere in the topology', () => {
    expect(() =>
      createCollaborationTopology([
        step({ taskId: 'a', publishesTo: ['t1'], requiredPublishesTo: ['t1'] }),
        step({ taskId: 'b', subscribesTo: ['t2'], admission: policy() })
      ])
    ).toThrow(/subscriber/)
  })

  it('accepts a required topic that has a subscriber elsewhere', () => {
    const topology = createCollaborationTopology([
      step({ taskId: 'a', publishesTo: ['t1'], requiredPublishesTo: ['t1'] }),
      step({ taskId: 'b', subscribesTo: ['t1'], admission: policy() })
    ])
    expect(topology.steps[0].requiredPublishesTo).toEqual(['t1'])
  })

  it('dedupes requiredPublishesTo preserving first occurrence order', () => {
    const topology = createCollaborationTopology([
      step({
        taskId: 'a',
        publishesTo: ['t2', 't1', 't3'],
        requiredPublishesTo: ['t2', 't1', 't2', 't3']
      }),
      step({ taskId: 'b', subscribesTo: ['t2', 't1', 't3'], admission: policy() })
    ])
    expect(topology.steps[0].requiredPublishesTo).toEqual(['t2', 't1', 't3'])
  })

  it('copies the requiredPublishesTo array instead of retaining the caller reference', () => {
    const requiredPublishesTo = ['t1']
    const topology = createCollaborationTopology([
      step({ taskId: 'a', publishesTo: ['t1'], requiredPublishesTo }),
      step({ taskId: 'b', subscribesTo: ['t1'], admission: policy() })
    ])
    expect(topology.steps[0].requiredPublishesTo).not.toBe(requiredPublishesTo)
    ;(requiredPublishesTo as string[]).push('t9')
    expect(topology.steps[0].requiredPublishesTo).toEqual(['t1'])
  })

  it('preserves undefined optional fields', () => {
    const topology = createCollaborationTopology([step({ taskId: 'a' })])
    expect(topology.steps[0].publishesTo).toBeUndefined()
    expect(topology.steps[0].subscribesTo).toBeUndefined()
    expect(topology.steps[0].admission).toBeUndefined()
  })
})

describe('allowedPublishTopicsForTask', () => {
  it('returns the deduped topics a task publishes', () => {
    const topology = createCollaborationTopology([
      step({ taskId: 'a', publishesTo: ['t1', 't2', 't1'] }),
      step({ taskId: 'b', publishesTo: ['t2'] })
    ])
    expect(allowedPublishTopicsForTask(topology, 'a')).toEqual(['t1', 't2'])
    expect(allowedPublishTopicsForTask(topology, 'b')).toEqual(['t2'])
  })

  it('returns an empty array when the task publishes nothing', () => {
    const topology = createCollaborationTopology([step({ taskId: 'a' })])
    expect(allowedPublishTopicsForTask(topology, 'a')).toEqual([])
  })

  it('returns an empty array for an unknown taskId', () => {
    const topology = createCollaborationTopology([step({ taskId: 'a' })])
    expect(allowedPublishTopicsForTask(topology, 'nope')).toEqual([])
  })
})

describe('subscribersForTopic', () => {
  it('returns taskIds in step declaration order', () => {
    const topology = createCollaborationTopology([
      step({ taskId: 'a', subscribesTo: ['t1'], admission: policy() }),
      step({ taskId: 'b', subscribesTo: ['t1', 't2'], admission: policy() }),
      step({ taskId: 'c', subscribesTo: ['t2'], admission: policy() })
    ])
    expect(subscribersForTopic(topology, 't1')).toEqual(['a', 'b'])
    expect(subscribersForTopic(topology, 't2')).toEqual(['b', 'c'])
  })

  it('returns an empty array when nobody subscribes', () => {
    const topology = createCollaborationTopology([step({ taskId: 'a' })])
    expect(subscribersForTopic(topology, 't1')).toEqual([])
  })
})

describe('admittedPublishOptionsForTopic', () => {
  it('returns each semantic type with the least restrictive priority that reaches a subscriber', () => {
    const topology = createCollaborationTopology([
      step({ taskId: 'pub', publishesTo: ['t1'], requiredPublishesTo: ['t1'] }),
      step({
        taskId: 'a',
        subscribesTo: ['t1'],
        admission: policy({ acceptedTypes: ['finding', 'report'], minPriority: 'high' })
      }),
      step({
        taskId: 'b',
        subscribesTo: ['t1'],
        admission: policy({ acceptedTypes: ['finding', 'status'], minPriority: 'normal' })
      }),
      step({
        taskId: 'c',
        subscribesTo: ['t1'],
        admission: policy({ acceptedTypes: ['report'], minPriority: 'urgent' })
      })
    ])

    expect(admittedPublishOptionsForTopic(topology, 't1')).toEqual([
      { semanticType: 'finding', minPriority: 'normal' },
      { semanticType: 'report', minPriority: 'high' },
      { semanticType: 'status', minPriority: 'normal' }
    ])
  })

  it('returns no options when subscribers admit no semantic type', () => {
    const topology = createCollaborationTopology([
      step({ taskId: 'a', subscribesTo: ['t1'], admission: policy({ acceptedTypes: [] }) })
    ])

    expect(admittedPublishOptionsForTopic(topology, 't1')).toEqual([])
    expect(admittedPublishOptionsForTopic(topology, 'missing')).toEqual([])
  })
})

describe('admissionPolicyForTask', () => {
  it('returns the step admission policy', () => {
    const admission = policy({ minPriority: 'high' })
    const topology = createCollaborationTopology([
      step({ taskId: 'a', admission }),
      step({ taskId: 'b' })
    ])
    expect(admissionPolicyForTask(topology, 'a')?.minPriority).toBe('high')
  })

  it('returns undefined for steps without admission', () => {
    const topology = createCollaborationTopology([step({ taskId: 'a' })])
    expect(admissionPolicyForTask(topology, 'a')).toBeUndefined()
  })

  it('returns undefined for an unknown taskId', () => {
    const topology = createCollaborationTopology([step({ taskId: 'a' })])
    expect(admissionPolicyForTask(topology, 'nope')).toBeUndefined()
  })
})

describe('requiredPublishTopicsForTask', () => {
  it('returns the deduped topics a task is required to publish', () => {
    const topology = createCollaborationTopology([
      step({ taskId: 'a', publishesTo: ['t1', 't2'], requiredPublishesTo: ['t2', 't1', 't2'] }),
      step({ taskId: 'b', subscribesTo: ['t1', 't2'], admission: policy() })
    ])
    expect(requiredPublishTopicsForTask(topology, 'a')).toEqual(['t2', 't1'])
  })

  it('returns an empty array when the task has no required topics', () => {
    const topology = createCollaborationTopology([step({ taskId: 'a' })])
    expect(requiredPublishTopicsForTask(topology, 'a')).toEqual([])
  })

  it('returns an empty array for an unknown taskId', () => {
    const topology = createCollaborationTopology([step({ taskId: 'a' })])
    expect(requiredPublishTopicsForTask(topology, 'nope')).toEqual([])
  })

  it('returns a fresh array each call', () => {
    const topology = createCollaborationTopology([
      step({ taskId: 'a', publishesTo: ['t1'], requiredPublishesTo: ['t1'] }),
      step({ taskId: 'b', subscribesTo: ['t1'], admission: policy() })
    ])
    const first = requiredPublishTopicsForTask(topology, 'a')
    const second = requiredPublishTopicsForTask(topology, 'a')
    expect(first).not.toBe(second)
    expect(first).not.toBe(topology.steps[0].requiredPublishesTo)
    ;(first as string[]).push('t9')
    expect(topology.steps[0].requiredPublishesTo).toEqual(['t1'])
  })
})
