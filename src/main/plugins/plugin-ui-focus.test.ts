import { describe, expect, it } from 'vitest'
import { PluginUiFocusSnapshot } from './plugin-ui-focus'

describe('PluginUiFocusSnapshot', () => {
  it('starts unknown and ignores duplicate reports', () => {
    const snapshot = new PluginUiFocusSnapshot()
    expect(snapshot.get()).toBeNull()

    const first = snapshot.apply({
      windowFocused: true,
      kind: 'terminal',
      title: 'zsh',
      worktreeId: 'wt-1'
    })
    expect(first).toEqual({
      changed: true,
      surface: { kind: 'terminal', title: 'zsh', worktreeId: 'wt-1' }
    })
    expect(
      snapshot.apply({
        windowFocused: true,
        kind: 'terminal',
        title: 'zsh',
        worktreeId: 'wt-1'
      }).changed
    ).toBe(false)
  })

  it('maps a path-bearing worktree id to a stable opaque token', () => {
    const snapshot = new PluginUiFocusSnapshot()
    const first = snapshot.apply({
      windowFocused: true,
      kind: 'terminal',
      title: 'zsh',
      worktreeId: 'repo-1::/Users/private/orca'
    })
    expect(first.surface?.worktreeId).toMatch(/^pj_[a-z0-9]+$/)
    expect(first.surface?.worktreeId).not.toContain('/')
    expect(
      snapshot.apply({
        windowFocused: true,
        kind: 'terminal',
        title: 'zsh',
        worktreeId: 'repo-1::/Users/private/orca'
      }).changed
    ).toBe(false)
    expect(snapshot.get()?.worktreeId).toBe(first.surface?.worktreeId)
  })

  it('clears on window blur and sanitizes titles', () => {
    const snapshot = new PluginUiFocusSnapshot()
    snapshot.apply({
      windowFocused: true,
      kind: 'editor',
      title: '/Users/private/repo/secret.ts'
    })
    expect(snapshot.get()).toEqual({ kind: 'editor', title: 'secret.ts' })

    const cleared = snapshot.apply({ windowFocused: false })
    expect(cleared).toEqual({ changed: true, surface: null })
    expect(snapshot.get()).toBeNull()
  })
})
