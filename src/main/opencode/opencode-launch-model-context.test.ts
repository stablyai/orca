import { describe, expect, it } from 'vitest'
import { parseOpenCodeLaunchModelContext } from './opencode-launch-model-context'
import { resolveOpenCodeLaunchModelConfig } from './opencode-launch-model-config'
import recordedCases from './opencode-resolved-agents.fixture.json'

const directory = '/private/project'
const snapshot = {
  directory,
  agents: {
    location: { directory },
    data: [
      { id: 'build', mode: 'primary', hidden: false },
      { id: 'reviewer', mode: 'primary' }
    ]
  }
}

describe('OpenCode execution-host primary-agent context', () => {
  it('uses the resolved first selectable primary and leaves absent identity unknown', () => {
    expect(parseOpenCodeLaunchModelContext(snapshot)).toEqual({ primaryAgent: 'build' })
    expect(
      parseOpenCodeLaunchModelContext({
        ...snapshot,
        agents: { location: { directory }, data: [] }
      })
    ).toBeNull()
  })

  it('uses recorded 2.0.19 resolved agents without inventing stale or disabled primaries', () => {
    for (const capture of recordedCases) {
      const original = JSON.parse(capture.configContent)
      const primaryAgent = capture.name === 'stale-default' ? 'build' : 'plan'
      const context = parseOpenCodeLaunchModelContext({
        directory: '/qa/project',
        agents: capture.settled
      })
      expect(context).toEqual({ primaryAgent })
      expect(
        JSON.parse(
          resolveOpenCodeLaunchModelConfig({
            configContent: capture.configContent,
            primaryAgent: context?.primaryAgent,
            model: capture.model
          }) ?? 'null'
        )
      ).toEqual({
        ...original,
        model: capture.model,
        agents: { ...original.agents, [primaryAgent]: { model: capture.model } }
      })

      const initialContext = parseOpenCodeLaunchModelContext({
        directory: '/qa/project',
        agents: capture.initial
      })
      expect(initialContext).toBeNull()
      expect(
        JSON.parse(
          resolveOpenCodeLaunchModelConfig({
            configContent: capture.configContent,
            primaryAgent: initialContext?.primaryAgent,
            model: capture.model
          }) ?? 'null'
        )
      ).toEqual({ ...original, model: capture.model })
      expect(
        resolveOpenCodeLaunchModelConfig({
          configContent: undefined,
          primaryAgent: initialContext?.primaryAgent,
          model: capture.model
        })
      ).toBe(JSON.stringify({ model: capture.model }))
    }
  })

  it('tolerates absent model fields and unrelated agent records', () => {
    expect(
      parseOpenCodeLaunchModelContext({
        ...snapshot,
        agents: {
          location: { directory },
          data: [
            { unrelated: true },
            { id: 'hidden', hidden: true },
            { id: 'child', mode: 'subagent' },
            { id: 'reviewer', mode: 'primary', model: null }
          ]
        }
      })
    ).toEqual({ primaryAgent: 'reviewer' })
  })

  it('never uses primary-agent data from a foreign location', () => {
    expect(
      parseOpenCodeLaunchModelContext({
        ...snapshot,
        agents: { ...snapshot.agents, location: { directory: '/other' } }
      })
    ).toBeNull()
  })
})
