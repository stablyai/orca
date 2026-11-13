import { describe, expect, it, vi } from 'vitest'
import { normalizePairedServerRow } from '../../../shared/sidebar-list/feed-facts/paired-server-rows'
import type { WorkspaceActivityFacts } from '../../../shared/sidebar-list/feed-facts/workspace-activity-facts'
import { buildWorkspaceRows } from '../../../shared/sidebar-list/feed-facts/workspace-rows'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type {
  MobileDesktopRelayHosts,
  MobileDesktopRelayListing
} from '../mobile-desktop-relay/mobile-desktop-relay-hosts'
import { PairedServerRowsProducer } from './workspace-rows/paired-server-rows-producer'
import { SidebarInputsFeed } from './feed/sidebar-inputs-feed'
import { ProducerRevision } from './producer-revision'
import {
  sidebarInputsFeedDomains,
  type SidebarInputsFeedSources
} from './sidebar-inputs-feed-domains'

vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getRegisteredSshState: () => null,
  listRegisteredSshTargets: () => []
}))
vi.mock('../../wsl/host-lifecycle/wsl-host-service-instance', () => ({
  getWslHostService: () => null
}))

const ID = 'r::/w/same'

function worktree(hostId: Worktree['hostId']): Worktree {
  return {
    id: ID,
    hostId,
    repoId: 'r',
    path: '/w/same',
    head: '',
    branch: 'refs/heads/same',
    isBare: false,
    isMainWorktree: false,
    displayName: 'same',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return { id: 'r', path: '/r', displayName: 'r', badgeColor: '', addedAt: 0, ...overrides }
}

/** This host lists `r::/w/same` locally and over SSH; a paired server lists the same id. */
function harness(
  hostFacts: Record<string, WorkspaceActivityFacts>,
  paired?: PairedServerRowsProducer
) {
  const listing = { scanned: true }
  const repos = [repo(), repo({ connectionId: 'box' })]
  const serverRow = normalizePairedServerRow('runtime:env', {
    worktreeId: ID,
    repoId: 'r',
    liveTerminalCount: 0,
    status: 'working'
  })
  const sources = {
    facts: {
      getWorkspaceActivityFacts: () => ({ revision: 0, facts: hostFacts }),
      workspaceActivityFacts: { revision: new ProducerRevision() }
    },
    pairedServerRows: paired ?? {
      revision: new ProducerRevision(),
      withPreparedSnapshot: async (consume: (snapshot: unknown) => void) =>
        consume({
          revision: 0,
          servers: [
            {
              hostId: 'runtime:env',
              freshness: 'live' as const,
              host: null,
              rows: serverRow ? [serverRow] : []
            }
          ]
        })
    },
    workspaceRows: {
      revision: new ProducerRevision(),
      ready: async () => {},
      snapshot: () =>
        listing.scanned
          ? {
              revision: 0,
              rows: Object.fromEntries(
                buildWorkspaceRows({
                  worktrees: [worktree('local'), worktree('ssh:box')],
                  folderWorkspaces: [],
                  repos,
                  lineageById: {}
                })
              )
            }
          : null
    },
    store: () => null,
    onClientEvent: () => () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the activity and workspaces domains read only the members built above.
  const domains = sidebarInputsFeedDomains(sources as unknown as SidebarInputsFeedSources)
  const read = (name: string) => {
    const domain = domains.find((candidate) => candidate.name === name)
    if (!domain) {
      throw new Error(`no ${name} domain`)
    }
    let result: Record<string, unknown> | null = null
    if (domain.prepare) {
      return domain
        .prepare(() => {
          result = domain.read()
        })
        .then(() => result)
    }
    return Promise.resolve(domain.read())
  }
  return {
    read,
    listing,
    domains,
    activityChanged: () => sources.facts.workspaceActivityFacts.revision.bump()
  }
}

describe('the activity domain', () => {
  it('never lends a paired server’s activity to this host’s same-id rows', async () => {
    const { read } = harness({})
    expect(Object.keys((await read('activity')) ?? {})).toEqual([`runtime:env|${ID}`])
  })

  it('publishes nothing until this host’s rows are first scanned', async () => {
    const { read, listing } = harness({})
    listing.scanned = false
    expect(await read('activity')).toBeNull()
  })
})

it('prepares first host facts and sees an external rename on an activity-only dirty pass', async () => {
  let name = 'Before'
  let release!: (listing: MobileDesktopRelayListing) => void
  let first = true
  const listing = (): MobileDesktopRelayListing => ({
    environments: [{ id: 'env', name, pairingRevision: 1, runtimeId: null }],
    statusByEnvironmentId: new Map(),
    sshTargetLabels: new Map(),
    sshConnectionStates: new Map()
  })
  const pending = new Promise<MobileDesktopRelayListing>((resolve) => {
    release = resolve
  })
  const hosts: MobileDesktopRelayHosts = {
    list: () => (first ? pending : listing()),
    resolve: async () => null,
    call: async () => {
      throw new Error('offline hosts require no network snapshot')
    },
    hostsBrowserPage: () => false,
    onEnvironmentRetired: () => () => {},
    onStatusChanged: () => () => {},
    watchChanges: () => {
      throw new Error('offline host must not be watched')
    }
  }
  const producer = new PairedServerRowsProducer({
    hasDemand: () => true,
    hostLabelOverrides: () => new Map()
  })
  const detach = producer.attach(hosts)
  const { domains, activityChanged } = harness({}, producer)
  const events: unknown[] = []
  const feed = new SidebarInputsFeed(
    () => domains.filter((domain) => ['activity', 'pairedServerHosts'].includes(domain.name)),
    (event) => {
      events.push(event)
    }
  )
  feed.acquire('phone')
  try {
    const reading = feed.read({ maxBytes: 256 * 1024 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toEqual([])
    first = false
    release(listing())
    const initial = await reading
    expect(initial.domains.pairedServerHosts.upserts).toMatchObject({
      'runtime:env': { host: { label: 'Before' } }
    })
    name = 'After'
    activityChanged()
    const renamed = await feed.read({ maxBytes: 256 * 1024 })
    expect(renamed.domains.pairedServerHosts.upserts).toMatchObject({
      'runtime:env': { host: { label: 'After' } }
    })
  } finally {
    feed.release('phone')
    detach()
  }
})
