import { describe, expect, it, vi } from 'vitest'
import type { SourceControlPrimaryActionDecisionInputs } from '../../../src/shared/source-control-primary-action-decision-types'
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
    forcePush: vi.fn(),
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

function decision(
  overrides: Partial<SourceControlPrimaryActionDecisionInputs> = {}
): SourceControlPrimaryActionDecisionInputs {
  return {
    stagedCount: 1,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: true,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
    ...overrides
  }
}

function args(
  overrides: Partial<MobileSourceControlActionArgs> = {}
): MobileSourceControlActionArgs {
  return {
    decision: decision(),
    rebaseBaseRef: 'origin/main',
    busyAction: null,
    openingPath: null,
    openingBranchPath: null,
    prAvailable: true,
    handlers: noopHandlers(),
    ...overrides
  }
}

describe('buildMobileSourceControlActions', () => {
  it('commits and pushes with lease after a rebase rewrote the branch', () => {
    const handlers = noopHandlers()
    const actions = buildMobileSourceControlActions(
      args({
        decision: decision({
          upstreamStatus: {
            hasUpstream: true,
            ahead: 2,
            behind: 2,
            behindCommitsArePatchEquivalent: true
          }
        }),
        handlers
      })
    )
    actions.find((action) => action.label === 'Commit & Force Push')?.onPress()
    expect(handlers.commitPush).toHaveBeenCalledWith(true)
  })

  it('keeps the Force Push warning visible while the row is enabled', () => {
    const actions = buildMobileSourceControlActions(
      args({ decision: decision({ upstreamStatus: { hasUpstream: true, ahead: 1, behind: 2 } }) })
    )
    const forcePush = actions.find((action) => action.label.startsWith('Force Push'))
    expect(forcePush?.disabled).toBe(false)
    expect(forcePush?.hint).toBeTruthy()
  })

  it('blocks force pushes when the review pushes to another remote', () => {
    const actions = buildMobileSourceControlActions(
      args({
        decision: decision({
          upstreamStatus: {
            hasUpstream: true,
            ahead: 2,
            behind: 2,
            behindCommitsArePatchEquivalent: true
          }
        }),
        forcePushBlockedReason: 'from desktop'
      })
    )
    for (const label of ['Commit & Force Push', 'Force Push']) {
      const row = actions.find((action) => action.label.startsWith(label))
      expect(row).toMatchObject({ disabled: true, hint: 'from desktop' })
    }
  })

  it('disables every row while another git action runs', () => {
    const actions = buildMobileSourceControlActions(args({ busyAction: 'fetch' }))
    expect(actions.every((action) => action.disabled)).toBe(true)
  })

  it('explains why a disabled row is disabled', () => {
    const actions = buildMobileSourceControlActions(
      args({ decision: decision({ stagedCount: 0 }) })
    )
    const commit = actions.find((action) => action.label === 'Commit')
    expect(commit?.disabled).toBe(true)
    expect(commit?.hint).toBeTruthy()
  })
})
