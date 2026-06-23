import { describe, expect, it, vi } from 'vitest'
import type { MobileGitUpstreamStatus } from './mobile-git-status'
import {
  buildMobileSourceControlActions,
  type MobileSourceControlActionArgs
} from './mobile-source-control-actions'

function noopHandlers(): MobileSourceControlActionArgs['handlers'] {
  return {
    commit: vi.fn(),
    commitPush: vi.fn(),
    commitSync: vi.fn(),
    push: vi.fn(),
    pull: vi.fn(),
    sync: vi.fn(),
    fetch: vi.fn(),
    publish: vi.fn(),
    fastForward: vi.fn(),
    rebase: vi.fn(),
    createPr: vi.fn(),
    pushAndCreatePr: vi.fn(),
    checkout: vi.fn(),
    history: vi.fn()
  }
}

function args(
  overrides: Partial<MobileSourceControlActionArgs> = {}
): MobileSourceControlActionArgs {
  return {
    commitMessage: 'msg',
    stagedCount: 1,
    upstream: { hasUpstream: true, ahead: 0, behind: 0 } as MobileGitUpstreamStatus,
    upstreamKnown: true,
    busyAction: null,
    openingPath: null,
    openingBranchPath: null,
    prAvailable: true,
    handlers: noopHandlers(),
    ...overrides
  }
}

function action(actions: ReturnType<typeof buildMobileSourceControlActions>, label: string) {
  return actions.find((a) => a.label.startsWith(label))
}

describe('buildMobileSourceControlActions', () => {
  it('includes the new parity actions', () => {
    const actions = buildMobileSourceControlActions(args())
    const labels = actions.map((a) => a.label)
    expect(labels.some((l) => l.startsWith('Fast-forward'))).toBe(true)
    expect(labels).toContain('Rebase onto base')
    expect(labels).toContain('Switch branch')
    expect(labels).toContain('History')
    expect(labels).toContain('Create PR')
  })

  it('enables Create PR only when a PR provider is available', () => {
    expect(
      action(buildMobileSourceControlActions(args({ prAvailable: true })), 'Create PR')?.disabled
    ).toBe(false)
    expect(
      action(buildMobileSourceControlActions(args({ prAvailable: false })), 'Create PR')?.disabled
    ).toBe(true)
  })

  it('disables fast-forward when ahead of upstream (would lose local commits)', () => {
    const actions = buildMobileSourceControlActions(
      args({ upstream: { hasUpstream: true, ahead: 2, behind: 3 } as MobileGitUpstreamStatus })
    )
    expect(action(actions, 'Fast-forward')?.disabled).toBe(true)
  })

  it('enables fast-forward when behind and not ahead', () => {
    const actions = buildMobileSourceControlActions(
      args({ upstream: { hasUpstream: true, ahead: 0, behind: 3 } as MobileGitUpstreamStatus })
    )
    expect(action(actions, 'Fast-forward')?.disabled).toBe(false)
  })

  it('blocks commit when no staged files', () => {
    const actions = buildMobileSourceControlActions(args({ stagedCount: 0 }))
    const commit = action(actions, 'Commit')
    expect(commit?.disabled).toBe(true)
    expect(commit?.hint).toBe('Stage at least one file')
  })

  it('wires handlers to their actions', () => {
    const handlers = noopHandlers()
    const actions = buildMobileSourceControlActions(args({ handlers }))
    action(actions, 'Switch branch')?.onPress()
    action(actions, 'History')?.onPress()
    expect(handlers.checkout).toHaveBeenCalled()
    expect(handlers.history).toHaveBeenCalled()
  })
})
