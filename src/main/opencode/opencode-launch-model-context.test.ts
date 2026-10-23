import { describe, expect, it } from 'vitest'
import { parseOpenCodeLaunchModelContext } from './opencode-launch-model-context'

const directory = '/private/project'
const snapshot = {
  directory,
  agents: {
    location: { directory },
    data: [
      { id: 'build', mode: 'primary', hidden: false },
      { id: 'reviewer', mode: 'primary' }
    ]
  },
  config: [{ type: 'document', info: { default_agent: 'reviewer' } }]
}

describe('OpenCode execution-host primary-agent context', () => {
  it('uses the configured primary independently of ordering and unrelated model metadata', () => {
    expect(parseOpenCodeLaunchModelContext(snapshot)).toEqual({ primaryAgent: 'reviewer' })
    expect(
      parseOpenCodeLaunchModelContext({
        ...snapshot,
        agents: { location: { directory }, data: [] }
      })
    ).toEqual({ primaryAgent: 'reviewer' })
  })

  it('tolerates new config kinds, absent model fields and unrelated agent records', () => {
    expect(
      parseOpenCodeLaunchModelContext({
        ...snapshot,
        config: [{ type: 'future' }],
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
