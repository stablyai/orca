import { describe, expect, it, vi } from 'vitest'

// The 1.14.0 barrel re-exports a `LucideProvider` its own context.mjs does not have; Metro and the
// web builder each paper over it, and nothing under test here renders an icon.
vi.mock('lucide-react-native', () => ({ GitBranch: vi.fn() }))
vi.mock('react-native-svg', () => ({ default: vi.fn(), Path: vi.fn() }))

import type { RouteHandoff } from '../navigation/route-handoff'
import { workspaceHref } from '../navigation/workspace-execution-host'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { buildWorktreeNavigationActions, openHistorySession } from './worktree-navigation-actions'

function historyRouter(): {
  replace: ReturnType<typeof vi.fn>
  back: ReturnType<typeof vi.fn>
  handoff: RouteHandoff
} {
  const replace = vi.fn()
  const back = vi.fn()
  return {
    replace,
    back,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: openHistorySession only calls replace and back.
    handoff: { replace, back } as RouteHandoff
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

  it('pins a local resume so the history route’s server is not copied onto it', () => {
    const { replace, handoff } = historyRouter()
    openHistorySession(handoff, 'host', 'host-a', 'from-wt', 'to-wt', 'resumed', null)
    const href = '/h/host-a/session/to-wt?name=resumed&executionHost='
    expect(replace).toHaveBeenCalledWith(href)
    expect(workspaceHref(href, 'ssh:builder')).toBe('/h/host-a/session/to-wt?name=resumed')
  })

  it('goes back when a session-origin resume stays on the same worktree and host', () => {
    const { replace, back, handoff } = historyRouter()
    openHistorySession(
      handoff,
      'session',
      'host-a',
      'wt',
      'wt',
      'name',
      'ssh:builder',
      'ssh:builder'
    )
    expect(back).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
  })

  it('treats a missing host and an explicit local host as the same machine', () => {
    const { replace, back, handoff } = historyRouter()
    openHistorySession(handoff, 'session', 'host-a', 'wt', 'wt', 'name', null, undefined)
    expect(back).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
  })

  it('replaces when a session-origin resume keeps the worktree but changes host', () => {
    const { replace, back, handoff } = historyRouter()
    openHistorySession(handoff, 'session', 'host-a', 'wt', 'wt', 'name', null, 'ssh:builder')
    expect(back).not.toHaveBeenCalled()
    const href = '/h/host-a/session/wt?name=name&executionHost='
    expect(replace).toHaveBeenCalledWith(href)
    expect(workspaceHref(href, 'ssh:builder')).toBe('/h/host-a/session/wt?name=name')
  })

  it('keeps the target host when it differs from the history route', () => {
    const { replace, back, handoff } = historyRouter()
    openHistorySession(handoff, 'session', 'host-a', 'wt', 'wt', 'name', 'ssh:other', 'ssh:builder')
    expect(back).not.toHaveBeenCalled()
    const href = '/h/host-a/session/wt?name=name&executionHost=ssh%3Aother'
    expect(replace).toHaveBeenCalledWith(href)
    expect(workspaceHref(href, 'ssh:builder')).toBe(href)
  })
})
