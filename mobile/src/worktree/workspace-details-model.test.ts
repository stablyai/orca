import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-types'
import { buildWorkspaceDetailLinks } from './workspace-details-model'

function row(overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: 'repo::/src/app',
    repoId: 'repo',
    repo: 'orca',
    branch: 'feat/x',
    displayName: 'x',
    path: '/src/app',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

describe('buildWorkspaceDetailLinks', () => {
  it("lists reviews first, then tasks in the host's order, as the desktop hover card does", () => {
    const links = buildWorkspaceDetailLinks(
      row({
        linkedItems: [
          { provider: 'jira', type: 'issue', number: 0, identifier: 'ORCA-4', title: 'Jira one' },
          { provider: 'linear', type: 'issue', number: 0, identifier: 'ENG-7' },
          { provider: 'github', type: 'issue', number: 3, title: 'Bug', url: 'https://x/3' }
        ],
        linkedPR: { number: 12, state: 'open' }
      })
    )

    expect(links.map((link) => link.label)).toEqual(['PR #12', 'ORCA-4', 'ENG-7', 'Issue #3'])
    expect(links[0]).toMatchObject({ state: 'open' })
    expect(links[3]).toMatchObject({ title: 'Bug', url: 'https://x/3' })
  })

  it('enriches a linked entry for the same repo and PR', () => {
    const links = buildWorkspaceDetailLinks(
      row({
        linkedItems: [
          {
            provider: 'github',
            type: 'pr',
            number: 12,
            repoId: 'repo',
            url: 'https://github.com/o/r/pull/12'
          }
        ],
        linkedPR: {
          number: 12,
          state: 'open',
          title: 'Branch PR',
          url: 'https://github.com/o/r/pull/12'
        }
      })
    )
    expect(links).toEqual([
      expect.objectContaining({ label: 'PR #12', title: 'Branch PR', state: 'open' })
    ])
  })

  it('keeps a same-numbered PR from another repo apart from the branch PR', () => {
    const links = buildWorkspaceDetailLinks(
      row({
        linkedItems: [
          {
            provider: 'github',
            type: 'pr',
            number: 12,
            title: 'Other repo',
            url: 'https://github.com/o/other/pull/12'
          },
          { provider: 'github', type: 'pr', number: 12, title: 'Other id', repoId: 'other-repo' }
        ],
        linkedPR: {
          number: 12,
          state: 'merged',
          title: 'Branch PR',
          url: 'https://github.com/o/r/pull/12'
        }
      })
    )
    expect(links.map((link) => [link.title, link.url, link.state])).toEqual([
      ['Other repo', 'https://github.com/o/other/pull/12', undefined],
      ['Other id', undefined, undefined],
      ['Branch PR', 'https://github.com/o/r/pull/12', 'merged']
    ])
  })

  it('never opens a non-web link the host sends for the branch PR', () => {
    const [pr] = buildWorkspaceDetailLinks(
      row({ linkedPR: { number: 3, state: 'open', url: 'javascript:alert(1)' } })
    )
    expect(pr).toMatchObject({ label: 'PR #3', url: undefined })
  })
})
