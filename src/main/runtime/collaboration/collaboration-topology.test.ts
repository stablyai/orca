import { describe, expect, it } from 'vitest'
import type { AdmissionPolicy } from './collaboration-admission'
import {
  admissionPolicyForTask,
  allowedPublishTopicsForTask,
  createCollaborationTopology,
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
