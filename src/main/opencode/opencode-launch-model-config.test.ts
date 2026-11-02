import { describe, expect, it } from 'vitest'
import { resolveOpenCodeLaunchModelConfig } from './opencode-launch-model-config'

describe('per-launch OpenCode model config', () => {
  it('retains credentials, permissions and other agents while overriding the resolved primary model', () => {
    const original = {
      model: 'provider/old',
      default_agent: 'reviewer',
      providers: {
        custom: { apiKey: 'placeholder-key', models: { preferred: { name: 'Preferred' } } }
      },
      permissions: [{ tool: 'shell', action: 'ask' }],
      agents: {
        reviewer: { model: 'provider/agent-old', system: 'Review only', permissions: [] },
        build: { model: 'provider/build', steps: 5 },
        nested: { mode: 'subagent', model: 'provider/nested' }
      }
    }
    const configContent = JSON.stringify(original)
    const merged = resolveOpenCodeLaunchModelConfig({
      configContent,
      primaryAgent: 'reviewer',
      model: 'provider/preferred'
    })
    expect(merged).not.toBeNull()
    expect(JSON.parse(merged ?? 'null')).toEqual({
      ...original,
      model: 'provider/preferred',
      agents: {
        ...original.agents,
        reviewer: { ...original.agents.reviewer, model: 'provider/preferred' }
      }
    })
    expect(configContent).toBe(JSON.stringify(original))
  })
})
