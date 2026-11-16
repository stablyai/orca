import { describe, expect, it } from 'vitest'
import { resolveNewTabAgentSurfaces } from './new-tab-agent-surface'

const agents = ['claude', 'pi', 'aider'] as const
const chatAgents = new Set(['claude', 'pi'])

function resolve(
  picked: 'chat' | 'terminal' | null,
  hostDefaults: Parameters<typeof resolveNewTabAgentSurfaces>[0]['hostDefaults']
) {
  const resolved = resolveNewTabAgentSurfaces({ agents, chatAgents, picked, hostDefaults })
  return {
    selected: resolved?.selected,
    surfaces: agents.map((agent) => resolved?.surfaceFor(agent))
  }
}

describe('resolveNewTabAgentSurfaces', () => {
  it('starts on Chat on a headless host with no choice of its own', () => {
    expect(resolve(null, null)).toEqual({
      selected: 'chat',
      surfaces: ['chat', 'chat', 'terminal']
    })
  })

  it("follows a desktop's per-agent choice until the phone picks", () => {
    const desktop = {
      agentDefaultSurface: 'terminal' as const,
      nativeChatProviders: { claude: true }
    }
    expect(resolve(null, desktop)).toEqual({
      selected: undefined,
      surfaces: ['chat', 'terminal', 'terminal']
    })
    expect(resolve('chat', desktop)).toEqual({
      selected: 'chat',
      surfaces: ['chat', 'chat', 'terminal']
    })
  })

  it('leaves chat agents to an older host that reports no choice', () => {
    expect(resolve(null, undefined)).toEqual({
      selected: undefined,
      surfaces: [undefined, undefined, 'terminal']
    })
  })
})
