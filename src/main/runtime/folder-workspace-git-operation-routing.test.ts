import { describe, expect, it } from 'vitest'
import {
  selectFolderWorkspaceAbortTarget,
  selectFolderWorkspaceCommitTarget,
  type FolderWorkspaceChildCandidate
} from './folder-workspace-git-operation-routing'

function readable(repoName: string, selected: boolean): FolderWorkspaceChildCandidate<string> {
  return { repoName, target: repoName, selected }
}

function unreadable(repoName: string, error: string): FolderWorkspaceChildCandidate<string> {
  return { repoName, error }
}

describe('selectFolderWorkspaceCommitTarget', () => {
  it('picks the single staged repo', () => {
    expect(
      selectFolderWorkspaceCommitTarget([readable('api', true), readable('portal', false)])
    ).toEqual({ ok: true, target: 'api' })
  })

  it('reports "nothing to commit" when no repo is staged, matching the single-repo path', () => {
    expect(
      selectFolderWorkspaceCommitTarget([readable('api', false), readable('portal', false)])
    ).toEqual({ ok: false, error: 'nothing to commit' })
  })

  it('refuses to commit when two repos are staged, naming both', () => {
    // Why: git has no cross-repo transaction — repo 1 committing then repo 2
    // failing leaves a half-done state no result shape can describe.
    const result = selectFolderWorkspaceCommitTarget([
      readable('api', true),
      readable('portal', true)
    ])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('api')
    expect(result.ok === false && result.error).toContain('portal')
  })

  it('fails closed on an unreadable repo even when exactly one other is staged', () => {
    // Why: the unreadable repo may be the one the user staged. Committing the
    // readable one and reporting success silently skips their work.
    const result = selectFolderWorkspaceCommitTarget([
      readable('api', true),
      unreadable('portal', 'not a git repository')
    ])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('portal: not a git repository')
  })

  it('fails closed on an unreadable repo before reporting "nothing to commit"', () => {
    const result = selectFolderWorkspaceCommitTarget([
      readable('api', false),
      unreadable('portal', 'permission denied')
    ])
    expect(result.ok === false && result.error).toContain('permission denied')
  })

  it('reports every unreadable repo, not just the first', () => {
    const result = selectFolderWorkspaceCommitTarget([
      unreadable('api', 'boom'),
      unreadable('portal', 'bang')
    ])
    expect(result.ok === false && result.error).toContain('api: boom')
    expect(result.ok === false && result.error).toContain('portal: bang')
  })

  it('reports "nothing to commit" for an empty workspace rather than throwing', () => {
    expect(selectFolderWorkspaceCommitTarget([])).toEqual({
      ok: false,
      error: 'nothing to commit'
    })
  })
})

describe('selectFolderWorkspaceAbortTarget', () => {
  it('picks the single repo in the operation', () => {
    expect(
      selectFolderWorkspaceAbortTarget([readable('api', true), readable('portal', false)], 'merge')
    ).toEqual({ ok: true, target: 'api' })
  })

  it('names the operation when nothing is in progress', () => {
    const result = selectFolderWorkspaceAbortTarget([readable('api', false)], 'rebase')
    expect(result).toEqual({
      ok: false,
      error: 'No repository in this workspace has a rebase in progress.'
    })
  })

  it('refuses when two repos are mid-operation rather than aborting an arbitrary one', () => {
    const result = selectFolderWorkspaceAbortTarget(
      [readable('api', true), readable('portal', true)],
      'merge'
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('More than one repository is mid-merge')
  })

  it('fails closed on an unreadable repo', () => {
    const result = selectFolderWorkspaceAbortTarget(
      [readable('api', true), unreadable('portal', 'gone')],
      'merge'
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('portal: gone')
  })
})
