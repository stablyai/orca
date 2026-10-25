import { describe, expect, it } from 'vitest'
import type {
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../../../shared/runtime-worktree-contracts'
import type { RpcContext } from './core'
import { markWorktreePsOtherClientRows } from './worktree-ps-other-client-marks'

function row(
  worktreeId: string,
  creatorProvenance?: RuntimeWorktreePsSummary['creatorProvenance']
): RuntimeWorktreePsSummary {
  return {
    worktreeId,
    repoId: 'repo',
    repo: 'repo',
    path: `/repo/${worktreeId}`,
    branch: worktreeId,
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: worktreeId,
    workspaceStatus: 'in-progress',
    sortOrder: 0,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    lastOutputAt: null,
    preview: '',
    status: 'inactive',
    agents: [],
    ...(creatorProvenance ? { creatorProvenance } : {})
  }
}

const rows = [
  row('desktop', { kind: 'host' }),
  row('laptop', { kind: 'paired-device', deviceId: 'laptop' }),
  row('unknown')
]
const result: RuntimeWorktreePsResult = { worktrees: rows, totalCount: 4, truncated: false }

function context(
  overrides: Partial<Pick<RpcContext, 'clientKind' | 'pairedDeviceParentId'>>
): Parameters<typeof markWorktreePsOtherClientRows>[1] {
  return overrides
}

function marked(next: RuntimeWorktreePsResult): string[] {
  return next.worktrees.filter((entry) => entry.desktopOtherClient).map((entry) => entry.worktreeId)
}

describe('markWorktreePsOtherClientRows', () => {
  it("marks, for this host's own phone, the rows its sidebar calls another client's", () => {
    expect(
      marked(markWorktreePsOtherClientRows(result, context({ clientKind: 'mobile' })))
    ).toEqual(['laptop'])
  })

  it('leaves rows untouched for any other caller', () => {
    expect(markWorktreePsOtherClientRows(result, context({ clientKind: 'runtime' }))).toBe(result)
    expect(markWorktreePsOtherClientRows(result, context({}))).toBe(result)
    expect(
      markWorktreePsOtherClientRows(
        result,
        context({ clientKind: 'mobile', pairedDeviceParentId: 'other-desktop' })
      )
    ).toBe(result)
  })
})
