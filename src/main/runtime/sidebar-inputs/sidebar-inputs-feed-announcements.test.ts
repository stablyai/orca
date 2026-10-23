// The announcement census (design §9.4): every domain names the writers of what it reads, and each
// writer, called through the real store, announces a change. No domain is re-read on a phone read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { Repo } from '../../../shared/repo-types'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { RuntimeStore } from '../runtime-store-contract'
import type { WslHostService } from '../../wsl/wsl-host-service'
import { setWslHostService } from '../../wsl/wsl-host-service-instance'
import { getGitHubPRCacheKeyCandidates } from '../../../shared/github/github-cache-key'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import {
  prGroupOfReviewFact,
  WorkspaceReviewFactsSnapshotSchema,
  type WorkspaceReviewFact
} from '../../../shared/sidebar-list/workspace-review-facts'
import { fixture } from '../../persistence/loading-store/profile-state-delayed-authority-fixture'
import { ProducerRevision, type ProducerChange } from './producer-revision'
import { SidebarInputsFeed, type SidebarInputsFeedChange } from './sidebar-inputs-feed'
import {
  sidebarInputsFeedDomains,
  type SidebarInputsFeedSources
} from './sidebar-inputs-feed-domains'
import { TestPhone } from './sidebar-inputs-feed.test-fixture'

const repo: Repo = { id: 'repo-1', path: '/r', displayName: 'r', badgeColor: 'blue', addedAt: 1 }
const worktree = {
  id: 'repo-1::/r/a',
  repoId: repo.id,
  hostId: 'local',
  branch: 'refs/heads/feature',
  linkedPR: null
} as const

async function host() {
  const { store } = await fixture()
  store.addRepo(repo)
  const clientEvents = new Set<(event: RuntimeClientEvent) => void>()
  const temporal = new Set<() => void>()
  const wslListeners = new Set<() => void>()
  const revisions = {
    activity: new ProducerRevision(),
    paired: new ProducerRevision(),
    creations: new ProducerRevision(),
    rows: new ProducerRevision(),
    detected: new ProducerRevision(),
    liveContent: new ProducerRevision()
  }
  // A WSL registry that only announces; this host has no WSL hosts.
  const wsl = {
    getStatuses: () => [],
    onStatusesChanged: (listener: () => void) => {
      wslListeners.add(listener)
      return () => wslListeners.delete(listener)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the desktop domain reads only these two members.
  setWslHostService(wsl as unknown as WslHostService)
  const sources: SidebarInputsFeedSources = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the domains read only the members stubbed here.
    facts: {
      workspaceActivityFacts: { revision: revisions.activity },
      getWorkspaceActivityFacts: () => ({ revision: 0, facts: {} }),
      getSidebarTemporalSnapshot: () => ({ sessionId: null, retention: null }),
      onSidebarTemporalChange: (listener: () => void) => {
        temporal.add(listener)
        return () => temporal.delete(listener)
      },
      detectedCheckouts: {
        revision: revisions.detected,
        snapshot: () => ({}),
        watch: (listener: () => void) => revisions.detected.onChange(listener)
      },
      workspaceLiveContent: { revision: revisions.liveContent, snapshot: () => ({}) }
    } as unknown as SidebarInputsFeedSources['facts'],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    pairedServerRows: {
      revision: revisions.paired,
      snapshot: () => ({ servers: [] }),
      catalogs: () => []
    } as unknown as SidebarInputsFeedSources['pairedServerRows'],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    workspaceCreations: {
      revision: revisions.creations,
      snapshot: () => ({ creations: {} })
    } as unknown as SidebarInputsFeedSources['workspaceCreations'],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above; one cached worktree, already scanned.
    workspaceRows: {
      revision: revisions.rows,
      snapshot: () => ({ revision: 0, rows: {} }),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: review facts read only these fields.
      resolvedWorktrees: () => [worktree as unknown as ResolvedWorktree],
      ready: async () => {}
    } as unknown as SidebarInputsFeedSources['workspaceRows'],
    repoIcons: { idsByRepo: () => ({}) },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real Store is a RuntimeStore.
    store: () => store as unknown as RuntimeStore,
    onClientEvent: (listener) => {
      clientEvents.add(listener)
      return () => clientEvents.delete(listener)
    }
  }
  const emit = (event: RuntimeClientEvent): void =>
    clientEvents.forEach((listener) => listener(event))
  const catalogEvent = (): void => emit({ type: 'reposChanged' })
  // Every public writer of what each domain reads.
  const writers: Record<string, Record<string, () => void>> = {
    activity: {
      'activity producer': () => revisions.activity.bump(),
      'paired server rows': () => revisions.paired.bump(),
      // Only a paired server's partition holds activity (its browser and chat tabs).
      'saved session': () =>
        store.patchWorkspaceSession({ activeTabId: 'tab-1' }, toRuntimeExecutionHostId('env-1'))
    },
    temporal: { 'retention owner': () => temporal.forEach((listener) => listener()) },
    creations: { 'creation registry': () => revisions.creations.bump() },
    workspaces: { 'workspace rows producer': () => revisions.rows.bump() },
    detected: { 'detected checkouts producer': () => revisions.detected.bump() },
    liveContent: { 'live content producer': () => revisions.liveContent.bump() },
    view: { 'ui write': () => store.updateUI({ groupBy: 'pr-status' }) },
    pairedServerHosts: { 'paired server rows': () => revisions.paired.bump() },
    pairedServerRows: { 'paired server rows': () => revisions.paired.bump() },
    desktop: {
      'catalog event': catalogEvent,
      'ui write': () => store.updateUI({ workspaceHostOrder: ['local'] }),
      'settings write': () =>
        store.updateSettings({
          showPinnedWorktreesInGroups: !store.getSettings().showPinnedWorktreesInGroups
        }),
      'saved session': () => store.patchWorkspaceSession({ activeWorktreeId: worktree.id }),
      'pin write': () =>
        store.setWorktreeMeta(hostWorktreeTarget({ id: worktree.id, hostId: 'local' }), {
          isPinned: true
        }),
      'WSL status': () => wslListeners.forEach((listener) => listener())
    },
    projectCatalog: {
      'catalog event': catalogEvent,
      'paired server rows': () => revisions.paired.bump(),
      'ui write': () => store.updateUI({ projectOrderBy: 'recent' }),
      'full save': () =>
        store.setWorktreeLineage(hostWorktreeTarget({ id: worktree.id, hostId: 'local' }), {
          worktreeId: worktree.id,
          worktreeInstanceId: 'a-1',
          parentWorktreeId: 'repo-1::/r/p',
          parentWorktreeInstanceId: 'p-1',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        })
    },
    repoIcons: { 'catalog event': catalogEvent },
    review: {
      'PR cache save': () => store.setGitHubCache({ ...store.getGitHubCache(), pr: {} }),
      'workspace rows producer': () => revisions.rows.bump(),
      'paired server rows': () => revisions.paired.bump(),
      'catalog event': catalogEvent
    }
  }
  return { store, sources, writers }
}

function feedReviewFact(value: unknown): WorkspaceReviewFact | null {
  const parsed = WorkspaceReviewFactsSnapshotSchema.shape.facts.valueType.safeParse(value)
  return parsed.success ? parsed.data : null
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  setWslHostService(null)
  vi.restoreAllMocks()
})

describe('sidebar inputs feed announcements', () => {
  it('lists the writers of every published domain', async () => {
    const { sources, writers } = await host()
    const names = sidebarInputsFeedDomains(sources).map((domain) => domain.name)
    expect(new Set(names)).toEqual(new Set(Object.keys(writers)))
  })

  it('hears every writer of every domain, through the real store', async () => {
    const { sources, writers } = await host()
    const unheard: string[] = []
    for (const domain of sidebarInputsFeedDomains(sources)) {
      for (const [writer, write] of Object.entries(writers[domain.name] ?? {})) {
        const heard: (SidebarInputsFeedChange | undefined)[] = []
        const detach = domain.watch((change) => heard.push(change))
        write()
        detach()
        if (heard.length === 0) {
          unheard.push(`${domain.name} <- ${writer}`)
        }
      }
    }
    expect(unheard).toEqual([])
  })

  it('publishes metadata and accepted commands as urgent', async () => {
    const { sources, writers } = await host()
    const domains = new Map(
      sidebarInputsFeedDomains(sources).map((domain) => [domain.name, domain])
    )
    const urgency = (name: string, writer: string): boolean => {
      const heard: (ProducerChange | undefined)[] = []
      const detach = domains.get(name)?.watch((change) => heard.push(change))
      writers[name][writer]()
      detach?.()
      return heard.some((change) => change?.urgent === true)
    }
    expect(urgency('creations', 'creation registry')).toBe(true)
    expect(urgency('desktop', 'pin write')).toBe(true)
    expect(urgency('view', 'ui write')).toBe(true)
  })

  it('follows a PR cache save on a quiet desktop into the phone’s PR grouping', async () => {
    const { store, sources } = await host()
    const events: { generation: string; revision: number }[] = []
    const feed = new SidebarInputsFeed(
      () => sidebarInputsFeedDomains(sources),
      (event) => events.push(event)
    )
    store.updateUI({ groupBy: 'pr-status' })
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    expect(phone.view().review).toBeUndefined()

    // Nothing else happens on this desktop: no catalog event, no phone read, no metadata write.
    const before = events.length
    const [key] = getGitHubPRCacheKeyCandidates(repo, 'feature')
    store.setGitHubCache({
      ...store.getGitHubCache(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: grouping reads only number and state.
      pr: { [key]: { data: { number: 7, state: 'merged' } as PRInfo, fetchedAt: 1 } }
    })
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(before))
    const notice = events.at(-1)
    if (!notice) {
      throw new Error('the PR cache save announced nothing')
    }
    phone.notice(notice)
    await phone.settle()
    const fact = phone.view().review?.[worktree.id]
    expect(fact).toEqual({ provider: 'github', reviewState: 'merged' })
    expect(prGroupOfReviewFact(feedReviewFact(fact))).toBe('done')
    phone.disconnect()
  })
})
