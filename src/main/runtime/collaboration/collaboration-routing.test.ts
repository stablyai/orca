import { describe, expect, it } from 'vitest'
import { getCollaboratorsForTopic, type CollaborationRoutingStep } from './collaboration-routing'

describe('getCollaboratorsForTopic', () => {
  const steps: readonly CollaborationRoutingStep[] = [
    { key: 'step-a', subscribesTo: ['topic-1', 'topic-2'] },
    { key: 'step-b', subscribesTo: ['topic-2'] },
    { key: 'step-c' }
  ]

  it('returns step keys subscribed to the topic in declaration order', () => {
    expect(getCollaboratorsForTopic(steps, 'topic-2')).toEqual(['step-a', 'step-b'])
  })

  it('returns an empty array for an unknown topic', () => {
    expect(getCollaboratorsForTopic(steps, 'no-such-topic')).toEqual([])
  })

  it('handles a step without subscribesTo', () => {
    expect(getCollaboratorsForTopic(steps, 'topic-3')).toEqual([])
  })

  it('dedupes duplicate subscriptions within a single step', () => {
    const dupSteps: readonly CollaborationRoutingStep[] = [
      { key: 'step-a', subscribesTo: ['topic-1', 'topic-1'] },
      { key: 'step-b', subscribesTo: ['topic-1'] }
    ]
    expect(getCollaboratorsForTopic(dupSteps, 'topic-1')).toEqual(['step-a', 'step-b'])
  })

  it('returns a defensive copy that is safe to mutate', () => {
    const result = getCollaboratorsForTopic(steps, 'topic-1')
    result.push('mutated')
    expect(getCollaboratorsForTopic(steps, 'topic-1')).toEqual(['step-a'])
    expect(result).toEqual(['step-a', 'mutated'])
  })

  it('returns a fresh array on every call', () => {
    const first = getCollaboratorsForTopic(steps, 'topic-2')
    const second = getCollaboratorsForTopic(steps, 'topic-2')
    expect(first).not.toBe(second)
  })

  it('accepts empty step lists and empty subscription lists', () => {
    expect(getCollaboratorsForTopic([], 'topic-1')).toEqual([])
    expect(getCollaboratorsForTopic([{ key: 'solo' }], 'topic-1')).toEqual([])
  })

  it('treats topics as opaque strings', () => {
    expect(getCollaboratorsForTopic(steps, 'topic-2 ')).toEqual([])
    expect(getCollaboratorsForTopic(steps, 'TOPIC-2')).toEqual([])
  })
})
