import { describe, expect, it, vi } from 'vitest'

// The 1.14.0 barrel re-exports a `LucideProvider` its own context.mjs does not have; Metro and the
// web builder each paper over it, and nothing under test here renders an icon.
vi.mock('lucide-react-native', () => ({ GitBranch: vi.fn() }))
vi.mock('react-native-svg', () => ({ default: vi.fn(), Path: vi.fn() }))

import type { RouteHandoff } from '../navigation/route-handoff'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { buildWorktreeNavigationActions, openHistorySession } from './worktree-navigation-actions'

function historyRouter(): { replace: ReturnType<typeof vi.fn>; handoff: RouteHandoff } {
  const replace = vi.fn()
  return {
    replace,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: openHistorySession only calls replace and back.
    handoff: { replace, back: vi.fn() } as RouteHandoff
  }
}

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

describe('openHistorySession', () => {
  it('keeps the resolved execution host on the replacement session route', () => {
    const { replace, handoff } = historyRouter()
    openHistorySession(
      handoff,
      'host',
      'host a?b',
      'from/wt',
      'to/wt',
      'resumed name',
      'ssh:builder'
    )
    expect(replace).toHaveBeenCalledWith(
      '/h/host%20a%3Fb/session/to%2Fwt?name=resumed%20name&executionHost=ssh%3Abuilder'
    )
  })

  it('adds the execution host as the only query when the session has no name', () => {
    const { replace, handoff } = historyRouter()
    openHistorySession(handoff, undefined, 'host-a', 'from-wt', 'to-wt', undefined, 'runtime:vm')
    expect(replace).toHaveBeenCalledWith('/h/host-a/session/to-wt?executionHost=runtime%3Avm')
  })

  it('leaves a local resume on the route host when the resolved execution host is null', () => {
    const { replace, handoff } = historyRouter()
    openHistorySession(handoff, 'host', 'host-a', 'from-wt', 'to-wt', 'resumed', null)
    expect(replace).toHaveBeenCalledWith('/h/host-a/session/to-wt?name=resumed')
  })
})
