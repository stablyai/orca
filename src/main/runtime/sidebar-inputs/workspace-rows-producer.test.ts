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
import type {
  ResolvedWorktreeRepoScans,
  ResolvedWorktreeScanJoin
} from '../workspaces/resolved-worktree-scan-join'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'

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

function setup(repos: Repo[] = [localRepo, sshRepo]) {
  let settings: Partial<ReturnType<RuntimeStore['getSettings']>> = {}
  const setWorktreeMeta = vi.fn<RuntimeStore['setWorktreeMeta']>()
  const writeListeners = new Set<(domains: readonly string[] | undefined) => void>()
  const onWrite = (domains: readonly string[] | undefined): void =>
    writeListeners.forEach((listener) => listener(domains))
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
    | 'setWorktreeMeta'
  > = {
    setWorktreeMeta,
    getRepos: () => repos,
    getRepo: (id) => repos.find((repo) => repo.id === id),
    getWorktreeMeta: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getFolderWorkspaces: () => [],
    getProjectGroups: () => [],
    getSshTargets: () => [],
    getAllWorktreeLineage: () => ({}),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the visibility filter reads only absent fields as defaults.
    getSettings: () => settings as ReturnType<RuntimeStore['getSettings']>,
    onStateWritten: (listener) => {
      writeListeners.add(listener)
      return () => writeListeners.delete(listener)
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
  let scans = 0
  // A new object per scan that really ran git; a cached scan repeats the last one.
  let gitRun: object = {}
  let freshGitRuns = true
  let scanGate: Promise<void> | null = null
  // The real listing cache and visibility filter run; only the scan and merge are stubbed.
  class Probe extends OrcaRuntimeService {
    protected override async computeResolvedWorktrees(): Promise<ResolvedWorktreeSnapshot> {
      return { ...listing, worktrees: [...listing.worktrees] }
    }

    protected override async scanResolvedWorktreeRepos(): Promise<ResolvedWorktreeRepoScans> {
      scans += 1
      await scanGate
      gitRun = freshGitRuns ? {} : gitRun
      return new Map()
    }

    // Every listed row as if scanned; a test edits `listing` to change what git or metadata says.
    protected override joinResolvedWorktreeScans(): ResolvedWorktreeScanJoin {
      return {
        ...listing,
        worktrees: [...listing.worktrees],
        unscannedRepoKeys: new Set(),
        gitRunById: new Map(
          listing.worktrees.map((row) => [composeWorktreeHostIdentity(row.hostId, row.id), gitRun])
        ),
        scannedRepoKeys: new Set(
          listing.worktrees.map((row) => getRepoHostIdentityForParts(row.repoId, row.hostId ?? ''))
        )
      }
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
    setWorktreeMeta,
    scans: () => scans,
    /** Whether the next scans run git again or answer from the scan cache. */
    setFreshGitRuns: (fresh: boolean) => {
      freshGitRuns = fresh
    },
    /** Holds every scan until the returned release runs. */
    holdScans(): () => void {
      let release = (): void => {}
      scanGate = new Promise((resolve) => {
        release = () => {
          scanGate = null
          resolve()
        }
      })
      return release
    },
    rows: requireSwitchedOn(runtime.workspaceRows),
    listing,
    write: (domains?: readonly string[]) => onWrite(domains),
    // As the store does: replace the settings in memory, then report a settings-tagged write.
    writeSettings: (updates: Partial<ReturnType<RuntimeStore['getSettings']>>) => {
      settings = { ...settings, ...updates }
      onWrite(['settings'])
    }
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
    await rows.settled()
    const snapshot = rows.snapshot()?.rows ?? {}
    expect(Object.keys(snapshot)).toEqual(['local|repo-1::/r/a', 'ssh:box|repo-2::/remote/b'])
    expect(snapshot['local|repo-1::/r/a']).toMatchObject({ kind: 'git', terminalPlatform: 'linux' })
    expect(snapshot['ssh:box|repo-2::/remote/b']).toMatchObject({ hostId: 'ssh:box', branch: '' })
  })

  it('moves on catalog changes and metadata writes, never on session or unrelated settings writes', () => {
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

  it('moves when a settings write changes what the visibility filter reads, and only then', () => {
    const { rows, writeSettings } = setup()
    const at = (): number => rows.revision.value
    const start = at()
    writeSettings({ compactWorktreeCards: true })
    expect(at()).toBe(start)
    writeSettings({ worktreeVisibilityDefaults: { external: 'show' } })
    expect(at()).toBe(start + 1)
    writeSettings({ worktreeVisibilityDefaults: { external: 'show' } })
    expect(at()).toBe(start + 1)
    writeSettings({ workspaceDir: '/w' })
    writeSettings({ nestWorkspaces: false })
    writeSettings({ workspaceDirHistory: [{ path: '/old', nestWorkspaces: true }] })
    expect(at()).toBe(start + 4)
  })

  it('republishes rows to the feed when a visibility setting is saved', async () => {
    // Added after the rollout, so the global default decides whether an external checkout shows.
    const recentRepo: Repo = { ...localRepo, id: 'repo-3', externalWorktreeVisibilityLegacy: false }
    const { runtime, listing, writeSettings } = setup([localRepo, sshRepo, recentRepo])
    listing.worktrees.push(resolved('repo-3::/external', recentRepo, 'local'))
    writeSettings({ worktreeVisibilityDefaults: { external: 'hide' } })
    const feed = requireSwitchedOn(runtime.sidebarInputsFeed)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    expect(Object.keys(phone.view().workspaces)).not.toContain('local|repo-3::/external')

    writeSettings({ worktreeVisibilityDefaults: { external: 'show' } })
    await vi.advanceTimersByTimeAsync(60)
    const notice = events.findLast((event) => event.type === 'sidebarInputsChanged')
    if (notice?.type !== 'sidebarInputsChanged') {
      throw new Error('no change notice')
    }
    phone.notice(notice)
    await phone.settle()
    expect(Object.keys(phone.view().workspaces)).toContain('local|repo-3::/external')
    phone.disconnect()
  })

  it('reads past the shared listing cache and leaves it alone', async () => {
    const { runtime, rows, listing } = setup()
    const key = 'local|repo-1::/r/a'
    const cachedPinned = async (): Promise<boolean | undefined> =>
      (await runtime.cachedListing()).worktrees[0]?.isPinned
    expect(await cachedPinned()).toBe(false)
    listing.worktrees[0] = { ...listing.worktrees[0], isPinned: true }
    await rows.settled()
    expect(rows.snapshot()?.rows[key]?.isPinned).toBe(true)
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

  it('publishes a metadata write at once while a scan is still running', async () => {
    const { runtime, listing, write, holdScans } = setup()
    const feed = requireSwitchedOn(runtime.sidebarInputsFeed)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    // A scan that never finishes: git is slow or the SSH host stalled.
    holdScans()
    runtime.emit({ type: 'worktreesChanged', repoId: 'repo-1' })
    await vi.advanceTimersByTimeAsync(60)
    const before = events.length

    listing.worktrees[0] = { ...listing.worktrees[0], isPinned: true }
    write(['worktreeMeta'])
    // One microtask turn, no timer: the urgent flush neither coalesces nor waits on the scan.
    await Promise.resolve()
    const notice = events.slice(before).find((event) => event.type === 'sidebarInputsChanged')
    if (notice?.type !== 'sidebarInputsChanged') {
      throw new Error('the write did not publish while the scan ran')
    }
    phone.notice(notice)
    await phone.settle()
    expect(phone.view().workspaces['local|repo-1::/r/a']).toMatchObject({ isPinned: true })
    phone.disconnect()
  })

  it('clears branch-scoped links when a scan sees the branch switch, and publishes the title', async () => {
    const { runtime, rows, listing, setWorktreeMeta } = setup()
    const detach = rows.revision.onChange(() => {})
    listing.worktrees[0] = {
      ...listing.worktrees[0],
      instanceId: 'i-1',
      displayNameMode: 'automatic',
      linkedPR: 7
    }
    await rows.settled()
    expect(setWorktreeMeta).not.toHaveBeenCalled()

    listing.worktrees[0] = { ...listing.worktrees[0], branch: 'refs/heads/b', displayName: 'b' }
    runtime.emit({ type: 'worktreesChanged', repoId: 'repo-1' })
    await rows.settled()
    expect(setWorktreeMeta).toHaveBeenCalledWith(
      { id: 'repo-1::/r/a', hostId: 'local' },
      expect.objectContaining({ linkedPR: null, pushTarget: undefined })
    )
    expect(rows.snapshot()?.rows['local|repo-1::/r/a']).toMatchObject({ displayName: 'b' })

    // Detached: the automatic title keeps the branch it last showed.
    listing.worktrees[0] = { ...listing.worktrees[0], branch: '', displayName: 'r', linkedPR: null }
    runtime.emit({ type: 'worktreesChanged', repoId: 'repo-1' })
    await rows.settled()
    expect(rows.snapshot()?.rows['local|repo-1::/r/a']).toMatchObject({ displayName: 'b' })
    detach()
  })

  it('times an urgent publish against a scan held for two seconds', async () => {
    vi.useRealTimers()
    const { runtime, listing, write, holdScans } = setup()
    const feed = requireSwitchedOn(runtime.sidebarInputsFeed)
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    const release = holdScans()
    const held = setTimeout(release, 2000)
    runtime.emit({ type: 'worktreesChanged', repoId: 'repo-1' })
    // Past the coalesce window, so only urgency can make the write publish at once.
    await new Promise((resolve) => setTimeout(resolve, 60))
    const published = new Promise<number>((resolve) => {
      const detach = runtime.onClientEvent((event) => {
        if (event.type === 'sidebarInputsChanged') {
          detach()
          resolve(performance.now())
        }
      })
    })
    const startedAt = performance.now()
    listing.worktrees[0] = { ...listing.worktrees[0], comment: 'renamed' }
    write(['worktreeMeta'])
    const elapsedMs = (await published) - startedAt
    clearTimeout(held)
    release()
    process.stdout.write(
      `[timing] urgent publish with a scan held 2000 ms: ${elapsedMs.toFixed(2)} ms\n`
    )
    expect(elapsedMs).toBeLessThan(20)
    phone.disconnect()
  })

  it('keeps a PR linked after a branch switch that a cached rescan did not see yet', async () => {
    const { runtime, rows, listing, write, setWorktreeMeta, setFreshGitRuns } = setup()
    const detach = rows.revision.onChange(() => {})
    listing.worktrees[0] = { ...listing.worktrees[0], instanceId: 'i-1' }
    await rows.settled()
    // `git checkout -b b`; the scan cache still answers with branch a.
    setFreshGitRuns(false)
    listing.worktrees[0] = { ...listing.worktrees[0], linkedPR: 9 }
    write(['worktreeMeta'])
    runtime.emit({ type: 'worktreesChanged', repoId: 'repo-1' })
    await rows.settled()
    // Git runs again and reports the new branch: the new branch's PR stays.
    setFreshGitRuns(true)
    listing.worktrees[0] = { ...listing.worktrees[0], branch: 'refs/heads/b' }
    runtime.emit({ type: 'worktreesChanged', repoId: 'repo-1' })
    await rows.settled()
    expect(setWorktreeMeta).not.toHaveBeenCalled()
    detach()
  })

  it('scans nothing for a metadata write', async () => {
    const { rows, write, scans } = setup()
    const detach = rows.revision.onChange(() => {})
    await rows.settled()
    const before = scans()
    write(['worktreeMeta'])
    write(undefined)
    await rows.settled()
    expect(scans()).toBe(before)
    detach()
  })

  it('rescans when the Windows runtime default changes, which announces no catalog event', async () => {
    const { rows, writeSettings, scans } = setup()
    const detach = rows.revision.onChange(() => {})
    await rows.settled()
    const before = scans()
    writeSettings({ compactWorktreeCards: true })
    await rows.settled()
    expect(scans()).toBe(before)
    writeSettings({ localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } })
    await rows.settled()
    expect(scans()).toBe(before + 1)
    detach()
  })
})
