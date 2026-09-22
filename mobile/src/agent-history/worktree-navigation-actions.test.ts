import { describe, expect, it, vi } from 'vitest'

// The 1.14.0 barrel re-exports a `LucideProvider` its own context.mjs does not have; Metro and the
// web builder each paper over it, and nothing under test here renders an icon.
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

  /**
   * The C1.2 class, at the last two sites that still had it.
   *
   * A host id is a deep link's to choose, and `useLocalSearchParams` answers the decoded value, so
   * one carrying `?`, `#` or whitespace stops being a single segment when it is interpolated raw.
   * Once `agent-history/[worktreeId]` is a page route the target is matched against
   * `matchesRoutePattern` before it is opened, and the id is the segment the pattern is reading.
   */
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
