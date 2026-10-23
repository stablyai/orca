import { describe, expect, it, vi } from 'vitest'
import { normalizePairedServerRow } from '../../../shared/sidebar-list/paired-server-rows'
import {
  IDLE_WORKSPACE_ACTIVITY,
  type WorkspaceActivityFacts
} from '../../../shared/sidebar-list/workspace-activity-facts'
import { buildWorkspaceRows } from '../../../shared/sidebar-list/workspace-rows'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { ProducerRevision } from './producer-revision'
import {
  sidebarInputsFeedDomains,
  type SidebarInputsFeedSources
} from './sidebar-inputs-feed-domains'

vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getRegisteredSshState: () => null,
  listRegisteredSshTargets: () => []
}))
vi.mock('../../wsl/wsl-host-service-instance', () => ({ getWslHostService: () => null }))

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
function harness(hostFacts: Record<string, WorkspaceActivityFacts>) {
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
    pairedServerRows: {
      revision: new ProducerRevision(),
      snapshot: () => ({
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
    return domain.read()
  }
  return { read, listing }
}

describe('the activity domain', () => {
  it('keys this host’s facts by its rows and a paired server’s by its own host', async () => {
    const busy = { ...IDLE_WORKSPACE_ACTIVITY, browser: true }
    const { read } = harness({ [ID]: busy })
    // The desktop's session names only the id, so both of its own copies carry it.
    expect(await read('activity')).toEqual({
      [`local|${ID}`]: busy,
      [`ssh:box|${ID}`]: busy,
      [`runtime:env|${ID}`]: { ...IDLE_WORKSPACE_ACTIVITY, agent: 'working' }
    })
  })

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
