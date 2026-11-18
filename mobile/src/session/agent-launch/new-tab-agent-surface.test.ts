import { describe, expect, it } from 'vitest'
import { resolveNewTabAgentSurfaces } from './new-tab-agent-surface'

const agents = ['claude', 'pi', 'aider'] as const

function resolve(
  picked: 'chat' | 'terminal' | null,
  hostDefaults: Parameters<typeof resolveNewTabAgentSurfaces>[0]['hostDefaults']
) {
  const resolved = resolveNewTabAgentSurfaces({
    agents,
    chatAgents: new Set(['claude', 'pi']),
    picked,
    hostDefaults
  })
  return (
    resolved && {
      selected: resolved.selected,
      chats: agents.map((agent) => resolved.nativeChatDefaultFor(agent))
    }
  )
}

describe('resolveNewTabAgentSurfaces', () => {
  it('starts chats on a headless host with no choice of its own', () => {
    expect(resolve(null, null)).toEqual({ selected: 'chat', chats: [true, true, false] })
  })

  it("follows a desktop's per-agent choice until the phone picks", () => {
    const desktop = {
      agentDefaultSurface: 'terminal' as const,
      nativeChatProviders: { claude: true }
    }
    expect(resolve(null, desktop)).toEqual({
      selected: undefined,
      chats: [undefined, undefined, undefined]
    })
    expect(resolve('chat', desktop)).toEqual({ selected: 'chat', chats: [true, true, false] })
  })

  it('leaves launches to an older host that publishes no choice', () => {
    expect(resolve('chat', undefined)).toBeNull()
  })
})
