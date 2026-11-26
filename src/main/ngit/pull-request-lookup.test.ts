import { describe, expect, it } from 'vitest'
import { findPullRequestForBranch } from './pull-request-lookup'
import { pickBranchRemote } from './repository-ref'
import { ngitPullRequestWorkspaceName } from './pull-request-worktree-base'
import type { ProjectedWorkItem } from './work-item-projection'

function pull(
  eventId: string,
  branchName: string,
  state: ProjectedWorkItem['item']['state'],
  headSha: string
): ProjectedWorkItem {
  return {
    item: {
      type: 'pr',
      number: Number.parseInt(eventId.slice(0, 8), 16),
      eventId,
      title: branchName,
      state,
      url: '',
      labels: [],
      createdAt: '',
      updatedAt: '',
      author: '',
      authorAvatarUrl: null,
      commentCount: 0,
      branchName,
      headSha
    },
    root: {
      id: eventId,
      pubkey: '',
      created_at: 0,
      kind: 1618,
      tags: [],
      content: '',
      sig: ''
    },
    activity: [],
    authorPubkey: '',
    body: '',
    comments: [],
    commentProfiles: new Map(),
    patches: [],
    cloneUrls: []
  }
}

const merged = pull('aaaaaaaa'.padEnd(64, '0'), 'splicing', 'merged', 'old')
const open = pull('bbbbbbbb'.padEnd(64, '0'), 'splicing', 'open', 'new')
const onMain = pull('cccccccc'.padEnd(64, '0'), 'master', 'open', 'tip')
const all = [merged, open, onMain]

describe('ngit pull request for a branch', () => {
  it.each([
    ['pr/splicing', undefined, open],
    ['splicing', undefined, open],
    ['pr/splicing(aaaaaaaa)', undefined, merged],
    [`fmar/${ngitPullRequestWorkspaceName(merged)}`, undefined, merged],
    // The default branch never borrows a pull request sent from a branch of the same name.
    ['master', 'tip', null],
    ['unrelated', undefined, null],
    ['unrelated', 'old', merged]
  ])('%s at %s', (branch, headOid, expected) => {
    expect(findPullRequestForBranch(all, branch, { headOid })).toBe(expected)
  })

  it('hides a finished pull request once its branch name moves on', () => {
    expect(findPullRequestForBranch([merged], 'pr/splicing', { headOid: 'newer' })).toBeNull()
    expect(findPullRequestForBranch([merged], 'pr/splicing', { headOid: 'old' })).toBe(merged)
  })
})

describe('the remote a branch belongs to', () => {
  const config = ['branch.master.remote nostr', 'branch.fix.remote origin'].join('\n')

  it('follows the branch, else the default branch, with push settings first', () => {
    expect(pickBranchRemote(config, 'fix')).toBe('origin')
    expect(pickBranchRemote(config, 'new-work')).toBe('nostr')
    expect(pickBranchRemote(`${config}\nremote.pushdefault nostr`, 'fix')).toBe('nostr')
    expect(pickBranchRemote(`${config}\nbranch.fix.pushremote nostr`, 'fix')).toBe('nostr')
    expect(pickBranchRemote('', 'fix')).toBeNull()
  })
})
