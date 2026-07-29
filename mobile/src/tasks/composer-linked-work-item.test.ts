import { describe, expect, it } from 'vitest'
import type { GitHubWorkItem, GitLabWorkItem, LinearIssue } from '../../../src/shared/types'
import {
  buildGitHubLinkedWorkItem,
  buildGitLabLinkedWorkItem,
  buildLinearLinkedWorkItem,
  buildSmartNameSelection,
  resolveComposerBranchPick,
  resolveComposerCreateSelection,
  resolveWorkItemAutoName,
  shouldApplyAutoName
} from './composer-linked-work-item'

describe('linked work item builders', () => {
  it('maps a GitHub PR into a linked work item', () => {
    const linked = buildGitHubLinkedWorkItem({
      type: 'pr',
      number: 42,
      title: 'Fix bug',
      url: 'https://github.com/o/r/pull/42',
      repoId: 'repo-1'
    })
    expect(linked).toMatchObject({ provider: 'github', type: 'pr', number: 42, repoId: 'repo-1' })
  })

  it('maps a GitLab MR into a linked work item', () => {
    const linked = buildGitLabLinkedWorkItem({
      type: 'mr',
      number: 7,
      title: 'Add feature',
      url: 'https://gitlab.com/g/p/-/merge_requests/7',
      repoId: 'repo-2'
    })
    expect(linked).toMatchObject({ provider: 'gitlab', type: 'mr', number: 7, repoId: 'repo-2' })
  })

  it('maps a Linear issue with identifier, workspace, and org key', () => {
    const linked = buildLinearLinkedWorkItem({
      identifier: 'ENG-9',
      title: 'Ship it',
      url: 'https://linear.app/acme/issue/ENG-9',
      workspaceId: 'ws-1'
    })
    expect(linked).toMatchObject({
      provider: 'linear',
      type: 'issue',
      number: 0,
      linearIdentifier: 'ENG-9',
      linearWorkspaceId: 'ws-1',
      linearOrganizationUrlKey: 'acme'
    })
  })
})

describe('shouldApplyAutoName', () => {
  it('applies when the name is empty or the previous auto-name', () => {
    expect(shouldApplyAutoName({ currentName: '', lastAutoName: '' })).toBe(true)
    expect(shouldApplyAutoName({ currentName: 'fix-bug', lastAutoName: 'fix-bug' })).toBe(true)
  })

  it('applies when the name is a lookup query (URL / #N)', () => {
    expect(shouldApplyAutoName({ currentName: '#42', lastAutoName: 'x' })).toBe(true)
    expect(shouldApplyAutoName({ currentName: 'ENG-9', lastAutoName: 'x' })).toBe(false)
  })

  it('keeps a deliberately typed name', () => {
    expect(shouldApplyAutoName({ currentName: 'my custom name', lastAutoName: 'other' })).toBe(
      false
    )
  })
})

describe('resolveWorkItemAutoName', () => {
  it('slugifies the title subject', () => {
    expect(
      resolveWorkItemAutoName({
        type: 'issue',
        number: 3,
        title: 'Fix the Login Bug',
        provider: 'github'
      })
    ).toBe('fix-the-login-bug')
  })
})

describe('buildSmartNameSelection', () => {
  const base = (over: Record<string, unknown>) => ({
    provider: 'github' as const,
    type: 'pr' as const,
    number: 12,
    title: 'T',
    url: 'u',
    ...over
  })

  it('maps GitHub PR / issue kinds and numbers the label', () => {
    expect(buildSmartNameSelection({ linkedWorkItem: base({}), baseBranch: undefined })).toEqual({
      kind: 'github-pr',
      label: '#12 T',
      url: 'u'
    })
    expect(
      buildSmartNameSelection({ linkedWorkItem: base({ type: 'issue' }), baseBranch: undefined })
    ).toMatchObject({ kind: 'github-issue' })
  })

  it('maps GitLab MR / issue kinds', () => {
    expect(
      buildSmartNameSelection({
        linkedWorkItem: base({ provider: 'gitlab', type: 'mr' }),
        baseBranch: undefined
      })
    ).toMatchObject({ kind: 'gitlab-mr' })
    expect(
      buildSmartNameSelection({
        linkedWorkItem: base({ provider: 'gitlab', type: 'issue' }),
        baseBranch: undefined
      })
    ).toMatchObject({ kind: 'gitlab-issue' })
  })

  it('maps Linear with a bare title label', () => {
    expect(
      buildSmartNameSelection({
        linkedWorkItem: base({ provider: 'linear', type: 'issue', number: 0, title: 'ENG-9 Ship' }),
        baseBranch: undefined
      })
    ).toEqual({ kind: 'linear', label: 'ENG-9 Ship', url: 'u' })
  })

  it('falls back to a branch pill', () => {
    expect(buildSmartNameSelection({ linkedWorkItem: null, baseBranch: 'main' })).toEqual({
      kind: 'branch',
      label: 'main'
    })
  })

  it('returns null when nothing is selected', () => {
    expect(buildSmartNameSelection({ linkedWorkItem: null, baseBranch: undefined })).toBeNull()
  })
})

describe('resolveComposerCreateSelection', () => {
  const baseCreateArgs = {
    branch: null,
    reuseEligibleBranch: null,
    reuseSelectedBranch: false,
    branchCreateIntent: false,
    name: ''
  }

  it('prefers a linked work item and passes resolved base fields', () => {
    const selection = resolveComposerCreateSelection({
      ...baseCreateArgs,
      linkedWorkItem: {
        provider: 'github',
        type: 'pr',
        number: 5,
        title: 'T',
        url: 'u',
        repoId: 'repo-1'
      },
      base: { baseBranch: 'main', compareBaseRef: 'origin/main', branchNameOverride: 'pr-5' }
    })
    expect(selection).toMatchObject({
      kind: 'work-item',
      baseBranch: 'main',
      compareBaseRef: 'origin/main',
      branchNameOverride: 'pr-5'
    })
  })

  it('marks reuse when the eligible branch is toggled on', () => {
    const selection = resolveComposerCreateSelection({
      ...baseCreateArgs,
      linkedWorkItem: null,
      base: { baseBranch: 'feature', branchNameOverride: 'feature' },
      branch: { refName: 'feature', localBranchName: 'feature' },
      reuseEligibleBranch: 'feature',
      reuseSelectedBranch: true
    })
    expect(selection).toEqual({
      kind: 'branch',
      baseBranch: 'feature',
      refName: 'feature',
      localBranchName: 'feature',
      reuse: true,
      branchNameOverride: 'feature'
    })
  })

  it('returns a new-branch selection when create-branch intent is set', () => {
    expect(
      resolveComposerCreateSelection({
        ...baseCreateArgs,
        linkedWorkItem: null,
        base: {},
        branchCreateIntent: true,
        name: 'feature/login'
      })
    ).toEqual({ kind: 'new-branch', branchName: 'feature/login' })
  })

  it('returns null with no work item, no branch base, and no intent', () => {
    expect(
      resolveComposerCreateSelection({ ...baseCreateArgs, linkedWorkItem: null, base: {} })
    ).toBeNull()
  })
})

describe('resolveComposerBranchPick', () => {
  it('auto-names and enables reuse for an unused local branch', () => {
    const pick = resolveComposerBranchPick({
      refName: 'feature',
      localBranchName: 'feature',
      currentName: '',
      lastAutoName: '',
      worktreeBranches: []
    })
    expect(pick.base).toEqual({ baseBranch: 'feature', branchNameOverride: 'feature' })
    expect(pick).toMatchObject({
      reuseEligibleBranch: 'feature',
      reuseSelectedBranch: true,
      name: 'feature'
    })
  })

  it('does not reuse a branch already checked out elsewhere', () => {
    const pick = resolveComposerBranchPick({
      refName: 'feature',
      localBranchName: 'feature',
      currentName: '',
      lastAutoName: '',
      worktreeBranches: ['refs/heads/feature']
    })
    expect(pick.reuseEligibleBranch).toBeNull()
    expect(pick.reuseSelectedBranch).toBe(false)
    expect(pick.base.branchNameOverride).toBeUndefined()
  })
})

// Keep the exported type aliases referenced so the module surface stays covered.
export type _Ref = [GitHubWorkItem, GitLabWorkItem, LinearIssue]
