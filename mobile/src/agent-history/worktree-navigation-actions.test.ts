import { describe, expect, it, vi } from 'vitest'

// Mock icons: 1.14.0 barrel exports missing LucideProvider; Metro/web patch it, and this suite renders no icons.
vi.mock('lucide-react-native', () => ({ GitBranch: vi.fn() }))
vi.mock('react-native-svg', () => ({ default: vi.fn(), Path: vi.fn() }))

import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { buildWorktreeNavigationActions } from './worktree-navigation-actions'

/** Every target these actions build, in the order they offer them. */
function targetsFor(hostId: string, worktreeId = 'wt-1'): string[] {
  const targets: string[] = []
  const actions = buildWorktreeNavigationActions({
    hostId,
    worktreeId,
    worktreeName: 'my worktree',
    hostCapabilities: [MOBILE_AI_VAULT_CAPABILITY],
    navigate: (target) => targets.push(target),
    onDone: () => {}
  })
  for (const action of actions) {
    action.onPress()
  }
  return targets
}

describe('the worktree row action sheet', () => {
  it('offers both screens on a host that advertises the vault', () => {
    expect(targetsFor('host-a')).toEqual([
      '/h/host-a/source-control/wt-1?name=my+worktree&origin=host',
      '/h/host-a/agent-history/wt-1?name=my+worktree'
    ])
  })

  it('opens a server workspace on its server, and offers nothing when that server is unreachable', () => {
    const forHost = (executionHost: 'runtime:vm' | null) => {
      const targets: string[] = []
      const actions = buildWorktreeNavigationActions({
        hostId: 'host-a',
        worktreeId: 'wt-1',
        worktreeName: 'w',
        executionHost,
        hostCapabilities: [MOBILE_AI_VAULT_CAPABILITY],
        navigate: (target) => targets.push(target),
        onDone: () => {}
      })
      actions.forEach((action) => action.onPress())
      return targets
    }
    expect(forHost('runtime:vm')).toEqual([
      '/h/host-a/source-control/wt-1?name=w&origin=host&executionHost=runtime%3Avm',
      '/h/host-a/agent-history/wt-1?name=w&executionHost=runtime%3Avm'
    ])
    expect(forHost(null)).toEqual([])
  })

  it('offers only source control on a host that does not', () => {
    const actions = buildWorktreeNavigationActions({
      hostId: 'host-a',
      worktreeId: 'wt-1',
      worktreeName: 'my worktree',
      hostCapabilities: [],
      navigate: () => {},
      onDone: () => {}
    })
    expect(actions.map((action) => action.label)).toEqual(['Source Control'])
  })

  // Encode decoded deep-link host ids: ?, # and whitespace must remain one segment for matchesRoutePattern before opening agent-history page.
  it('encodes a host id that would otherwise stop being one segment', () => {
    expect(targetsFor('host a?b#c')).toEqual([
      '/h/host%20a%3Fb%23c/source-control/wt-1?name=my+worktree&origin=host',
      '/h/host%20a%3Fb%23c/agent-history/wt-1?name=my+worktree'
    ])
  })

  it('encodes the worktree id the same way, which it already did', () => {
    expect(targetsFor('host-a', 'wt/1')).toEqual([
      '/h/host-a/source-control/wt%2F1?name=my+worktree&origin=host',
      '/h/host-a/agent-history/wt%2F1?name=my+worktree'
    ])
  })
})
