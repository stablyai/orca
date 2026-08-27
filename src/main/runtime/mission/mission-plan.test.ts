import { describe, expect, it } from 'vitest'
import { buildMissionPlanningPrompt, parseMissionPlan } from './mission-plan'

describe('Mission planning contract', () => {
  it('accepts a single-agent plan', () => {
    expect(parseMissionPlan('{"mode":"single-agent"}')).toEqual({ mode: 'single-agent' })
  })

  it('accepts a parallel collaboration plan with explicit topic semantics', () => {
    expect(
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'Compare two layers',
          maxConcurrency: 2,
          tasks: [
            {
              key: 'producer',
              spec: 'Inspect the producer layer and publish findings.',
              deps: [],
              publishesTo: ['/findings'],
              requiredPublishesTo: ['/findings']
            },
            {
              key: 'consumer',
              spec: 'Work independently and incorporate producer findings.',
              deps: [],
              subscribesTo: ['/findings'],
              admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
            }
          ]
        })
      )
    ).toMatchObject({
      mode: 'orchestration',
      maxConcurrency: 2,
      tasks: [
        { key: 'producer', requiredPublishesTo: ['/findings'] },
        { key: 'consumer', subscribesTo: ['/findings'] }
      ]
    })
  })

  it('rejects required publish topics outside the publish allowlist', () => {
    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'invalid',
          maxConcurrency: 2,
          tasks: [
            {
              key: 'producer',
              spec: 'produce',
              publishesTo: ['/allowed'],
              requiredPublishesTo: ['/required']
            },
            { key: 'consumer', spec: 'consume' }
          ]
        })
      )
    ).toThrow('requiredPublishesTo must be a subset of publishesTo')
  })

  it('rejects subscriptions without a publisher or admission policy', () => {
    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'invalid',
          maxConcurrency: 2,
          tasks: [
            { key: 'a', spec: 'one', subscribesTo: ['/missing'] },
            { key: 'b', spec: 'two' }
          ]
        })
      )
    ).toThrow('subscribesTo requires admission')

    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'invalid',
          maxConcurrency: 2,
          tasks: [
            {
              key: 'a',
              spec: 'one',
              subscribesTo: ['/missing'],
              admission: { acceptedTypes: ['finding'] }
            },
            { key: 'b', spec: 'two' }
          ]
        })
      )
    ).toThrow('subscribesTo topic has no publisher')
  })

  it('rejects dependency cycles', () => {
    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'cycle',
          maxConcurrency: 2,
          tasks: [
            { key: 'a', spec: 'one', deps: ['b'] },
            { key: 'b', spec: 'two', deps: ['a'] }
          ]
        })
      )
    ).toThrow('dependency cycle detected')
  })

  it('tells the planner to emit semantic collaboration intent, not execution mechanics', () => {
    const prompt = buildMissionPlanningPrompt(
      'Use two agents and let one feed findings to the other.'
    )
    expect(prompt).toContain('publishesTo')
    expect(prompt).toContain('requiredPublishesTo')
    expect(prompt).toContain('subscribesTo')
    expect(prompt).toContain('admission')
    expect(prompt).toContain('Do not choose execution backends')
    expect(prompt).toContain('deps only gate execution order')
    expect(prompt).toContain('must use collaboration topics')
    expect(prompt).toContain('Return JSON only')
  })
})
