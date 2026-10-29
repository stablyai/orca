import { describe, expect, it } from 'vitest'
import type { Worktree } from './workspace-list-types'
import {
  buildWorkspaceDetailLinks,
  buildWorkspaceOrigin,
  workspaceNotes
} from './workspace-details-model'

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

  it('reads the singular fields of a host that predates linkedItems', () => {
    const links = buildWorkspaceDetailLinks(
      row({ linkedIssue: 4, linkedGitLabMR: 9, linkedGitLabIssue: 2, linkedLinearIssue: 'ENG-1' })
    )

    expect(links.map((link) => `${link.provider} ${link.label}`)).toEqual([
      'gitlab MR !9',
      'github Issue #4',
      'gitlab Issue #2',
      'linear ENG-1'
    ])
  })

  it('lists a reference once when the attachments and a singular field both name it', () => {
    const links = buildWorkspaceDetailLinks(
      row({
        linkedItems: [{ provider: 'github', type: 'issue', number: 4, title: 'Bug' }],
        linkedIssue: 4
      })
    )

    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ label: 'Issue #4', title: 'Bug' })
  })

  it("carries the row's PR state, title, link and checks onto its entry", () => {
    const [pr, other] = buildWorkspaceDetailLinks(
      row({
        linkedItems: [{ provider: 'github', type: 'pr', number: 9, title: 'Older linked PR' }],
        linkedPR: {
          number: 12,
          state: 'merged',
          title: 'Search keyboard',
          url: 'https://github.com/o/r/pull/12',
          checksStatus: 'failure'
        }
      })
    )

    expect(pr).toMatchObject({ label: 'PR #9', title: 'Older linked PR' })
    expect(pr).not.toHaveProperty('state')
    expect(other).toMatchObject({
      label: 'PR #12',
      number: 12,
      title: 'Search keyboard',
      url: 'https://github.com/o/r/pull/12',
      state: 'merged',
      checks: 'failure'
    })
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

  it('names a GitLab review an MR', () => {
    expect(buildWorkspaceDetailLinks(row({ linkedGitLabMR: 5 }))[0]).toMatchObject({
      label: 'MR !5',
      number: 5
    })
  })

  it('drops attachments this build cannot place and never opens a non-web link', () => {
    const linkedItems = JSON.parse(
      JSON.stringify([
        'garbage',
        { provider: 'sourceforge', type: 'issue', number: 1 },
        { provider: 'github', type: 'issue', number: 0 },
        { provider: 'github', type: 'issue', number: 8, url: 'javascript:alert(1)' }
      ])
    )
    const links = buildWorkspaceDetailLinks(row({ linkedItems }))

    expect(links).toEqual([])
  })

  it('keeps two same-numbered issues from different repos apart, as the desktop does', () => {
    const links = buildWorkspaceDetailLinks(
      row({
        linkedItems: [
          {
            provider: 'github',
            type: 'issue',
            number: 4,
            url: 'https://github.com/a/one/issues/4'
          },
          { provider: 'github', type: 'issue', number: 4, url: 'https://github.com/a/two/issues/4' }
        ]
      })
    )

    expect(links.map((link) => link.url)).toEqual([
      'https://github.com/a/one/issues/4',
      'https://github.com/a/two/issues/4'
    ])
  })
})

describe('workspace origin', () => {
  it('names the automation the host names, and says only that one made it on an older host', () => {
    expect(
      buildWorkspaceOrigin(row({ automationCreated: true, automationName: ' Nightly deps ' }))
    ).toEqual({ kind: 'automation', name: 'Nightly deps' })
    expect(buildWorkspaceOrigin(row({ automationCreated: true }))).toEqual({ kind: 'automation' })
    expect(buildWorkspaceOrigin(row({ cliCreated: true }))).toEqual({ kind: 'cli' })
    expect(buildWorkspaceOrigin(row())).toBeNull()
  })
})

it('treats blank notes as none', () => {
  expect(workspaceNotes({ comment: '  \n ' })).toBeNull()
  expect(workspaceNotes({ comment: ' Check iPad ' })).toBe('Check iPad')
})
