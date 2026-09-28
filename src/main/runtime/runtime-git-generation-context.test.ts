import { describe, expect, it, vi } from 'vitest'

import { linkedIssueForTarget } from './runtime-git-generation-context'
import type { RuntimeGitCommandHost, RuntimeGitTarget } from './runtime-git-command-target'

const WORKTREE_ID = 'repo-1::/workspace/feature'

function makeTarget(links: {
  linkedIssue?: number | null
  linkedGitLabIssue?: number | null
  linkedWorkItem?: RuntimeGitTarget['worktree']['linkedWorkItem']
}): RuntimeGitTarget {
  const target = { worktree: { id: WORKTREE_ID, linkedIssue: null, ...links } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: linkedIssueForTarget reads only the worktree id and the three link slots set here.
  return target as unknown as RuntimeGitTarget
}

function makeHost(overrides: Partial<RuntimeGitCommandHost> = {}): RuntimeGitCommandHost {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the two optional linked-issue readers are called on this path.
  return overrides as unknown as RuntimeGitCommandHost
}

describe('linkedIssueForTarget', () => {
  it('returns the GitHub number for a GitHub-linked target', () => {
    expect(linkedIssueForTarget(makeHost(), makeTarget({ linkedIssue: 42 }))).toBe(42)
  })

  // The SSH execution host is a separate reader layer from the desktop IPC path;
  // fixing one never reaches the other, so this slot needs its own assertion.
  it('returns the GitLab number for a GitLab-linked target', () => {
    expect(
      linkedIssueForTarget(makeHost(), makeTarget({ linkedIssue: null, linkedGitLabIssue: 7 }))
    ).toBe(7)
  })

  it('refuses to guess when both forge slots are filled', () => {
    expect(
      linkedIssueForTarget(makeHost(), makeTarget({ linkedIssue: 3, linkedGitLabIssue: 7 }))
    ).toBeNull()
  })

  it('lets a linked work item break the two-forge tie', () => {
    expect(
      linkedIssueForTarget(
        makeHost(),
        makeTarget({
          linkedIssue: 3,
          linkedGitLabIssue: 7,
          linkedWorkItem: {
            provider: 'gitlab',
            type: 'issue',
            number: 7,
            title: 't',
            url: 'https://gitlab.com/a/b/-/issues/7'
          }
        })
      )
    ).toBe(7)
  })

  // `undefined` means the host could not answer, not "unlinked".
  it('prefers the host meta reader over the projection', () => {
    const getWorktreeLinkedIssueMeta = vi.fn(() => ({
      linkedIssue: null,
      linkedGitLabIssue: 99,
      linkedWorkItem: null
    }))
    expect(
      linkedIssueForTarget(
        makeHost({ getWorktreeLinkedIssueMeta }),
        makeTarget({ linkedIssue: 42 })
      )
    ).toBe(99)
    expect(getWorktreeLinkedIssueMeta).toHaveBeenCalledWith(WORKTREE_ID)
  })

  it('falls back to the projection when the host cannot answer', () => {
    expect(
      linkedIssueForTarget(
        makeHost({ getWorktreeLinkedIssueMeta: vi.fn(() => undefined) }),
        makeTarget({ linkedIssue: null, linkedGitLabIssue: 7 })
      )
    ).toBe(7)
  })

  it('returns null for an unlinked target', () => {
    expect(linkedIssueForTarget(makeHost(), makeTarget({}))).toBeNull()
  })
})
