// Runs on plain Node, as orcad does: rows come from the runtime's own listing and store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { OrcaRuntimeService } from '../orca-runtime'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import type { RuntimeStore } from '../runtime-store-contract'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { requireSwitchedOn } from './require-switched-on'
import { TestPhone } from './sidebar-inputs-feed.test-fixture'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const localRepo: Repo = {
  id: 'repo-1',
  path: '/r',
  displayName: 'r',
  badgeColor: 'blue',
  addedAt: 1
}
const sshRepo: Repo = {
  id: 'repo-2',
  path: '/remote',
  displayName: 'remote',
  badgeColor: 'red',
  addedAt: 1,
  connectionId: 'box'
}

function resolved(id: string, repo: Repo, hostId: ResolvedWorktree['hostId']): ResolvedWorktree {
  return {
    id,
    repoId: repo.id,
    hostId,
    path: id.split('::')[1],
    branch: hostId === 'local' ? 'refs/heads/a' : '',
    head: '',
    isBare: false,
    isMainWorktree: false,
    displayName: 'a',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path: id, head: '', branch: '', isBare: false, isMainWorktree: false }
  }
}

function setup() {
  let onWrite: (domains: readonly string[] | undefined) => void = () => {}
  const store: Pick<
    RuntimeStore,
    | 'getRepos'
    | 'getRepo'
    | 'getWorktreeMeta'
    | 'getAllWorktreeMeta'
    | 'getFolderWorkspaces'
    | 'getProjectGroups'
    | 'getSshTargets'
    | 'getAllWorktreeLineage'
    | 'getSettings'
    | 'onStateWritten'
  > = {
    getRepos: () => [localRepo, sshRepo],
    getRepo: (id) => [localRepo, sshRepo].find((repo) => repo.id === id),
    getWorktreeMeta: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getFolderWorkspaces: () => [],
    getProjectGroups: () => [],
    getSshTargets: () => [],
    getAllWorktreeLineage: () => ({}),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the visibility filter reads only absent fields as defaults.
    getSettings: () => ({}) as ReturnType<RuntimeStore['getSettings']>,
    onStateWritten: (listener) => {
      onWrite = listener
      return () => {}
    }
  }
  const listing: ResolvedWorktreeSnapshot = {
    // An SSH repo lists its stored rows whether or not the host answers.
    worktrees: [
      resolved('repo-1::/r/a', localRepo, 'local'),
      resolved('repo-2::/remote/b', sshRepo, 'ssh:box')
    ],
    platformByRepoId: new Map([['repo-1', 'linux']])
  }
  // The real listing cache and visibility filter run; only the scan and merge are stubbed.
  class Probe extends OrcaRuntimeService {
    protected override async computeResolvedWorktrees(): Promise<ResolvedWorktreeSnapshot> {
      return { ...listing, worktrees: [...listing.worktrees] }
    }

    emit(event: RuntimeClientEvent): void {
      this.emitClientEvent(event)
    }

    cachedListing(): Promise<ResolvedWorktreeSnapshot> {
      return this.listResolvedWorktreeSnapshot()
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only the fields picked above.
  const runtime = new Probe(store as RuntimeStore)
  return {
    runtime,
    rows: requireSwitchedOn(runtime.workspaceRows),
    listing,
    write: (domains?: readonly string[]) => onWrite(domains)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WorkspaceRowsProducer', () => {
  it('lists local and stored SSH rows by host, with the terminal platform', async () => {
    const { rows } = setup()
    const { rows: snapshot } = await rows.snapshot()
    expect(Object.keys(snapshot)).toEqual(['local|repo-1::/r/a', 'ssh:box|repo-2::/remote/b'])
    expect(snapshot['local|repo-1::/r/a']).toMatchObject({ kind: 'git', terminalPlatform: 'linux' })
    expect(snapshot['ssh:box|repo-2::/remote/b']).toMatchObject({ hostId: 'ssh:box', branch: '' })
  })

  it('moves on catalog changes and metadata writes, never on session or settings writes', () => {
    const { runtime, rows, write } = setup()
    const at = (): number => rows.revision.value
    const start = at()
    write(['workspaceSession'])
    write(['settings'])
    runtime.emit({ type: 'workspaceViewChanged' })
    expect(at()).toBe(start)

    write(['worktreeMeta'])
    write(undefined)
    runtime.emit({ type: 'worktreesChanged', repoId: 'repo-1' })
    runtime.emit({ type: 'reposChanged' })
    expect(at()).toBe(start + 4)
  })

  it('reads past the shared listing cache and leaves it alone', async () => {
    const { runtime, rows, listing } = setup()
    const key = 'local|repo-1::/r/a'
    const cachedPinned = async (): Promise<boolean | undefined> =>
      (await runtime.cachedListing()).worktrees[0]?.isPinned
    expect(await cachedPinned()).toBe(false)
    listing.worktrees[0] = { ...listing.worktrees[0], isPinned: true }
    expect((await rows.snapshot()).rows[key]?.isPinned).toBe(true)
    // worktree.ps and the temporal owner keep reading the listing they cached.
    expect(await cachedPinned()).toBe(false)
  })

  it('reaches the phone feed as the workspaces domain', async () => {
    const { runtime, listing, write } = setup()
    const feed = requireSwitchedOn(runtime.sidebarInputsFeed)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    expect(Object.keys(phone.view().workspaces)).toEqual([
      'local|repo-1::/r/a',
      'ssh:box|repo-2::/remote/b'
    ])

    listing.worktrees[0] = { ...listing.worktrees[0], isPinned: true }
    write(['worktreeMeta'])
    await vi.advanceTimersByTimeAsync(60)
    const notice = events.findLast((event) => event.type === 'sidebarInputsChanged')
    if (notice?.type !== 'sidebarInputsChanged') {
      throw new Error('no change notice')
    }
    phone.notice(notice)
    await phone.settle()
    expect(phone.replies.at(-1)).toMatchObject({
      kind: 'delta',
      domains: { workspaces: { upserts: { 'local|repo-1::/r/a': { isPinned: true } } } }
    })
    expect(Object.keys(phone.replies.at(-1)?.domains.workspaces.upserts ?? {})).toEqual([
      'local|repo-1::/r/a'
    ])
    phone.disconnect()
  })
})
