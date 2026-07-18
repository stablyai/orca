import type { GitHubWorkItem, GitLabWorkItem, LinearIssue } from '../../../src/shared/types'
import { getLinearIssueWorkspaceName } from '../../../src/shared/workspace-name'
import {
  buildGitHubWorkspaceSource,
  buildGitLabWorkspaceSource,
  buildLinearWorkspaceSource,
  buildWorkspaceSourceSelection,
  getWorkspaceSourceName,
  shouldApplyWorkspaceSourceAutoName
} from '../../../src/shared/new-workspace/workspace-source'
import { resolveComposerBranchPick as resolveSharedComposerBranchPick } from '../../../src/shared/composer-branch-selection'
import type {
  MobileComposerCreateSelection,
  MobileLinkedWorkItem,
  SmartNameSelection
} from './mobile-composer-source-types'
import type { WorkspaceCreateGitPushTarget } from './workspace-create-params'

export function buildGitHubLinkedWorkItem(item: {
  type: 'issue' | 'pr'
  number: number
  title: string
  url: string
  repoId: string
}): MobileLinkedWorkItem {
  return buildGitHubWorkspaceSource(item)
}

export function buildGitLabLinkedWorkItem(item: {
  type: 'issue' | 'mr'
  number: number
  title: string
  url: string
  repoId: string
}): MobileLinkedWorkItem {
  return buildGitLabWorkspaceSource(item)
}

export function buildLinearLinkedWorkItem(issue: {
  identifier: string
  title: string
  url: string
  workspaceId?: string
}): MobileLinkedWorkItem {
  return buildLinearWorkspaceSource(issue)
}

// Faithful port of desktop applyLinkedWorkItem's name gate: the derived name
// replaces the current field only when it's empty, still the last auto-name, or
// a lookup query — never a name the user deliberately typed.
export function shouldApplyAutoName(args: { currentName: string; lastAutoName: string }): boolean {
  return shouldApplyWorkspaceSourceAutoName(args)
}

export function resolveWorkItemAutoName(item: {
  type: 'issue' | 'pr' | 'mr'
  number: number
  title: string
  provider: 'github' | 'gitlab' | 'linear'
  linearIdentifier?: string
}): string {
  return getWorkspaceSourceName({ ...item, url: '' }).seedName
}

export function resolveLinearAutoName(issue: { identifier: string; title: string }): string {
  return getLinearIssueWorkspaceName(issue)
}

// Derives the pill descriptor from the linked item (or a plain branch base),
// mirroring desktop's smartNameSelection memo.
export function buildSmartNameSelection(args: {
  linkedWorkItem: MobileLinkedWorkItem | null
  baseBranch: string | undefined
}): SmartNameSelection | null {
  return buildWorkspaceSourceSelection(args) as SmartNameSelection | null
}

// Derives the create-time selection from composer state: a linked work item wins
// (carrying its resolved base/push fields), else a picked branch, else null (a
// name-only/blank create).
export function resolveComposerCreateSelection(args: {
  linkedWorkItem: MobileLinkedWorkItem | null
  base: {
    baseBranch?: string
    compareBaseRef?: string
    pushTarget?: WorkspaceCreateGitPushTarget
    branchNameOverride?: string
  }
  branch: { refName: string; localBranchName: string } | null
  reuseEligibleBranch: string | null
  reuseSelectedBranch: boolean
  branchCreateIntent: boolean
  name: string
}): MobileComposerCreateSelection | null {
  const { linkedWorkItem, base, branch, reuseEligibleBranch, reuseSelectedBranch } = args
  if (linkedWorkItem) {
    return {
      kind: 'work-item',
      item: linkedWorkItem,
      baseBranch: base.baseBranch,
      compareBaseRef: base.compareBaseRef,
      pushTarget: base.pushTarget,
      branchNameOverride: base.branchNameOverride
    }
  }
  if (branch && base.baseBranch) {
    return {
      kind: 'branch',
      baseBranch: base.baseBranch,
      refName: branch.refName,
      localBranchName: branch.localBranchName,
      reuse: reuseSelectedBranch && reuseEligibleBranch === branch.localBranchName,
      branchNameOverride: base.branchNameOverride
    }
  }
  if (args.branchCreateIntent && args.name.trim()) {
    return { kind: 'new-branch', branchName: args.name.trim() }
  }
  return null
}

export type ComposerBranchPick = {
  base: { baseBranch: string; branchNameOverride?: string }
  reuseEligibleBranch: string | null
  reuseSelectedBranch: boolean
  name?: string
  lastAutoName?: string
}

// Pure port of desktop handleSmartBranchSelect's derivation: base + reuse
// eligibility/default + the auto-name to apply, from the shared branch helpers.
export function resolveComposerBranchPick(args: {
  refName: string
  localBranchName: string
  currentName: string
  lastAutoName: string
  worktreeBranches: readonly string[]
}): ComposerBranchPick {
  const selection = resolveSharedComposerBranchPick(args)
  return {
    base: {
      baseBranch: selection.baseBranch,
      branchNameOverride: selection.branchNameOverride
    },
    reuseEligibleBranch: selection.reuseEligibleBranch,
    reuseSelectedBranch: selection.defaultReuse,
    ...(selection.name !== undefined && selection.lastAutoName !== undefined
      ? { name: selection.name, lastAutoName: selection.lastAutoName }
      : {})
  }
}

export type { GitHubWorkItem, GitLabWorkItem, LinearIssue }
