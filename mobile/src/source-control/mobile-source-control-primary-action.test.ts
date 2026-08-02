import { describe, expect, it, vi } from 'vitest'
import { resolveSourceControlCommitAreaPrimaryActionDecision } from '../../../src/shared/source-control-primary-action-decision'
import {
  resolveMobileSourceControlCommitAreaPrimaryActionDecision,
  type MobileSourceControlPrimaryActionDecisionInputs
} from './mobile-source-control-primary-action-decision'
import {
  buildMobileSourceControlPrimaryAction,
  type MobileSourceControlPrimaryActionArgs,
  type MobileSourceControlPrimaryActionHandlers
} from './mobile-source-control-primary-action'
import type { MobileGitStatusResult } from './mobile-git-status'

function handlers(): MobileSourceControlPrimaryActionHandlers {
  return {
    commit: vi.fn(async () => true),
    stageAll: vi.fn(async () => undefined),
    runActionSheetGitSequence: vi.fn(async () => undefined),
    runActionSheetGitSync: vi.fn(async () => undefined)
  }
}

function status(overrides: Partial<MobileGitStatusResult> = {}): MobileGitStatusResult {
  return {
    entries: [],
    conflictOperation: 'unknown',
    branch: 'feature',
    head: 'abc123',
    upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
    ...overrides
  }
}

function args(overrides: Partial<MobileSourceControlPrimaryActionArgs> = {}) {
  return {
    status: status(),
    hasUnresolvedConflicts: false,
    stageablePaths: [],
    stagedCount: 0,
    unstagedCount: 0,
    commitMessage: '',
    busyAction: null,
    openingPath: null,
    openingBranchPath: null,
    branchCompareResult: null,
    handlers: handlers(),
    ...overrides
  }
}

describe('buildMobileSourceControlPrimaryAction', () => {
  it('selects Stage All for unstaged work and dispatches the stage runner', () => {
    const h = handlers()
    const action = buildMobileSourceControlPrimaryAction(
      args({
        stageablePaths: ['a.ts'],
        unstagedCount: 1,
        handlers: h
      })
    )
    expect(action.label).toBe('Stage All')
    expect(action.disabled).toBe(false)
    action.onPress()
    expect(h.stageAll).toHaveBeenCalledTimes(1)
  })

  it('selects Commit for staged work with a message and dispatches commit', () => {
    const h = handlers()
    const action = buildMobileSourceControlPrimaryAction(
      args({
        stagedCount: 1,
        commitMessage: 'Ship it',
        handlers: h
      })
    )
    expect(action.label).toBe('Commit')
    expect(action.disabled).toBe(false)
    action.onPress()
    expect(h.commit).toHaveBeenCalledTimes(1)
  })

  it('selects Publish Branch only when a current branch exists', () => {
    expect(
      buildMobileSourceControlPrimaryAction(
        args({ status: status({ upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 } }) })
      ).label
    ).toBe('Publish Branch')
    const detached = buildMobileSourceControlPrimaryAction(
      args({
        status: status({
          branch: undefined,
          upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
        })
      })
    )
    expect(detached.label).toBe('Commit')
    expect(detached.disabled).toBe(true)
  })

  it('dispatches force push with lease when the shared decision requires it', () => {
    const h = handlers()
    const action = buildMobileSourceControlPrimaryAction(
      args({
        status: status({
          upstreamStatus: {
            hasUpstream: true,
            ahead: 10,
            behind: 2,
            behindCommitsArePatchEquivalent: true
          }
        }),
        branchCompareResult: {
          entries: [],
          summary: {
            status: 'ready',
            baseRef: 'main',
            baseOid: 'base',
            compareRef: 'HEAD',
            changedFiles: 0,
            commitsAhead: 3,
            headOid: 'abc',
            mergeBase: 'def'
          }
        },
        handlers: h
      })
    )
    expect(action.label).toBe('Force Push')
    expect(action.requiresForceWithLease).toBe(true)
    action.onPress()
    expect(h.runActionSheetGitSequence).toHaveBeenCalledWith('force-push', [
      { method: 'git.push', params: { forceWithLease: true } }
    ])
  })

  it('disables the button for unresolved entries even during a conflict operation', () => {
    const action = buildMobileSourceControlPrimaryAction(
      args({
        status: status({ conflictOperation: 'merge' }),
        hasUnresolvedConflicts: true,
        stagedCount: 1,
        commitMessage: 'Resolve'
      })
    )
    expect(action.label).toBe('Commit')
    expect(action.disabled).toBe(true)
    expect(action.accessibilityHint).toBe('Resolve conflicts before committing.')
  })

  it('does not block solely because a conflict operation exists without unresolved entries', () => {
    const action = buildMobileSourceControlPrimaryAction(
      args({
        status: status({ conflictOperation: 'merge' }),
        hasUnresolvedConflicts: false,
        stagedCount: 1,
        commitMessage: 'Resolve'
      })
    )
    expect(action.disabled).toBe(false)
  })
})

function decisionInputs(
  overrides: Partial<MobileSourceControlPrimaryActionDecisionInputs> = {}
): MobileSourceControlPrimaryActionDecisionInputs {
  return {
    stagedCount: 0,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: undefined,
    ...overrides
  }
}

describe('mobile source-control primary action decision parity', () => {
  it.each([
    {
      name: 'dirty tree stages first',
      input: decisionInputs({
        hasUnstagedChanges: true,
        hasStageableChanges: true,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 2 }
      })
    },
    {
      name: 'staged message commits',
      input: decisionInputs({ stagedCount: 1, hasMessage: true })
    },
    {
      name: 'staged without message blocks commit',
      input: decisionInputs({ stagedCount: 1, hasMessage: false })
    },
    {
      name: 'unresolved conflicts block commit',
      input: decisionInputs({ stagedCount: 1, hasMessage: true, hasUnresolvedConflicts: true })
    },
    {
      name: 'unpublished branch publishes',
      input: decisionInputs({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        hasCurrentBranch: true
      })
    },
    {
      name: 'detached head blocks publish',
      input: decisionInputs({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        hasCurrentBranch: false
      })
    },
    {
      name: 'tracked ahead pushes',
      input: decisionInputs({ upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 } })
    },
    {
      name: 'tracked behind pulls',
      input: decisionInputs({ upstreamStatus: { hasUpstream: true, ahead: 0, behind: 3 } })
    },
    {
      name: 'tracked diverged syncs',
      input: decisionInputs({ upstreamStatus: { hasUpstream: true, ahead: 2, behind: 3 } })
    },
    {
      name: 'patch-equivalent diverged force-pushes with lease',
      input: decisionInputs({
        branchCommitsAhead: 4,
        upstreamStatus: {
          hasUpstream: true,
          upstreamName: 'origin/feature',
          ahead: 10,
          behind: 2,
          behindCommitsArePatchEquivalent: true
        }
      })
    },
    {
      name: 'in-flight pull mirrors pull',
      input: decisionInputs({
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'pull',
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 }
      })
    },
    {
      name: 'in-flight force push mirrors force push',
      input: decisionInputs({
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'force_push',
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 }
      })
    },
    {
      name: 'in-flight push blocks committable candidate',
      input: decisionInputs({
        isRemoteOperationActive: true,
        inFlightRemoteOpKind: 'push',
        stagedCount: 1,
        hasMessage: true
      })
    }
  ])('matches the shared commit-area decision for $name', ({ input }) => {
    expect(resolveMobileSourceControlCommitAreaPrimaryActionDecision(input)).toEqual(
      resolveSourceControlCommitAreaPrimaryActionDecision(input)
    )
  })
})
