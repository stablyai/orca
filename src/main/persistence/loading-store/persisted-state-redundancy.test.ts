import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from '../persistence-test-harness'
// Compact serialization must load identically to legacy full defaults and replicated global fields.
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { BrowserHistoryEntry } from '../../../shared/browser-workspace-types'
import { WORKTREE_META_PERSISTED_DEFAULTS } from '../../../shared/worktree/meta-persisted-defaults'
import { HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS } from '../../../shared/workspace-session-host-field-ownership'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('./store')

const META_ROWS = 1_200
const IDENTITY_ROWS = 1_191
const HISTORY_ENTRIES = 200
const REMOTE_HOSTS = Array.from({ length: 9 }, (_, index) => `runtime:env-${index}`)
const HOSTS_WITH_REPLICA = REMOTE_HOSTS.slice(0, 3)
const LINKED_ROW_STRIDE = 40
// Keep fixture metadata newer than the 30-day GC cutoff.
const RECENTLY = Date.now()

const stores: InstanceType<typeof Store>[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  await closeTestStores()
  vi.restoreAllMocks()
})

function openStore(dataFile: string): InstanceType<typeof Store> {
  const store = createSqliteTestStore(Store, { dataFile })
  stores.push(store)
  return store
}

function tempDataFile(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'orca-redundancy-'))), 'orca-data.json')
}

function legacyMeta(index: number): WorktreeMeta {
  return {
    ...WORKTREE_META_PERSISTED_DEFAULTS,
    instanceId: `instance-${index}`,
    hostId: 'local',
    displayName: `workspace-${index}`,
    comment: '',
    isUnread: index % 7 === 0,
    sortOrder: RECENTLY + index,
    lastActivityAt: RECENTLY + index,
    createdAt: RECENTLY,
    workspaceStatus: 'none',
    ...(index % LINKED_ROW_STRIDE === 0 ? { linkedPR: index + 1, isPinned: true } : {})
  } as WorktreeMeta
}

function browserHistory(): BrowserHistoryEntry[] {
  return Array.from({ length: HISTORY_ENTRIES }, (_, index) => ({
    url: `https://example.test/page-${index}?q=${'x'.repeat(40)}`,
    normalizedUrl: `https://example.test/page-${index}?q=${'x'.repeat(40)}`,
    title: `A reasonably long page title number ${index}`,
    lastVisitedAt: 1_700_000_000_000 - index,
    visitCount: (index % 9) + 1
  }))
}

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  } as WorkspaceSessionState
}

/** Model legacy default slots and replicated local-owned global session fields. */
function writeLegacyFile(dataFile: string): void {
  const worktreeMeta: Record<string, WorktreeMeta> = {}
  for (let index = 0; index < META_ROWS; index++) {
    worktreeMeta[`repo-1::/tmp/wt-${index}`] = legacyMeta(index)
  }
  const worktreeMetaByIdentity: Record<string, WorktreeMeta> = {}
  for (let index = 0; index < IDENTITY_ROWS; index++) {
    worktreeMetaByIdentity[`wt2:local:instance-${index}`] = legacyMeta(index)
  }
  const history = browserHistory()
  const workspaceSessionsByHostId: Record<string, WorkspaceSessionState> = {}
  for (const hostId of REMOTE_HOSTS) {
    workspaceSessionsByHostId[hostId] = session({
      activeTabId: `tab-${hostId}`,
      ...(HOSTS_WITH_REPLICA.includes(hostId) ? { browserUrlHistory: history } : {})
    })
  }
  const state = {
    // Registered: the load-time deregistered-repo sweep drops residue rows for unknown repos.
    repos: [{ id: 'repo-1', name: 'repo-1', path: '/tmp/repo-1', worktreesPath: '/tmp' }],
    projects: [],
    worktreeMeta,
    worktreeMetaByIdentity,
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    workspaceSession: session({ activeTabId: 'local-tab', browserUrlHistory: history }),
    workspaceSessionsByHostId
  } as unknown as PersistedState
  writeFileSync(dataFile, JSON.stringify(state), 'utf-8')
}

/** Recreate legacy serialization to isolate savings from omitted defaults and replicated globals. */
function reexpandToLegacySerialization(state: PersistedState): PersistedState {
  const expanded = structuredClone(state)
  for (const map of [expanded.worktreeMeta, expanded.worktreeMetaByIdentity]) {
    for (const [key, meta] of Object.entries(map ?? {})) {
      ;(map as Record<string, WorktreeMeta>)[key] = { ...WORKTREE_META_PERSISTED_DEFAULTS, ...meta }
    }
  }
  for (const hostId of REMOTE_HOSTS) {
    const slice = expanded.workspaceSessionsByHostId?.[hostId as never]
    if (!slice) {
      continue
    }
    slice.browserUrlHistory = HOSTS_WITH_REPLICA.includes(hostId)
      ? expanded.workspaceSession.browserUrlHistory
      : []
    slice.workspaceDocHistory = []
  }
  return expanded
}

function defaultedSlotOccurrences(json: string): number {
  let count = 0
  for (const field of Object.keys(WORKTREE_META_PERSISTED_DEFAULTS)) {
    count += json.split(`"${field}":`).length - 1
  }
  return count
}

describe('persisted-state redundancy', () => {
  it('round-trips a legacy-shaped file to identical in-memory state and a smaller file', () => {
    const dataFile = tempDataFile()
    writeLegacyFile(dataFile)

    // Settle one-time fixture migrations before comparing serialization.
    openStore(dataFile).flush()

    const loaded = openStore(dataFile)
    const before = {
      meta: structuredClone(loaded.getAllWorktreeMeta()),
      local: structuredClone(loaded.getWorkspaceSession()),
      byHost: Object.fromEntries(
        REMOTE_HOSTS.map((hostId) => [hostId, structuredClone(loaded.getWorkspaceSession(hostId))])
      )
    }
    for (const meta of Object.values(before.meta)) {
      for (const field of Object.keys(WORKTREE_META_PERSISTED_DEFAULTS)) {
        expect(meta).toHaveProperty(field)
      }
    }

    loaded.flush()
    const rewritten = readPersistedStateJson(dataFile)

    expect(defaultedSlotOccurrences(rewritten)).toBe(
      (Math.ceil(META_ROWS / LINKED_ROW_STRIDE) + Math.ceil(IDENTITY_ROWS / LINKED_ROW_STRIDE)) * 2
    )
    const onDisk = JSON.parse(rewritten) as PersistedState
    for (const hostId of REMOTE_HOSTS) {
      for (const field of HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS) {
        expect(onDisk.workspaceSessionsByHostId?.[hostId]).not.toHaveProperty(field)
      }
    }
    // Compare equivalent states so missing synthetic-fixture settings do not inflate savings.
    expect(Buffer.byteLength(rewritten)).toBeLessThan(
      Buffer.byteLength(JSON.stringify(reexpandToLegacySerialization(onDisk))) * 0.6
    )

    const reloaded = openStore(dataFile)
    expect(reloaded.getAllWorktreeMeta()).toEqual(before.meta)
    expect(reloaded.getWorkspaceSession()).toEqual(before.local)
    for (const hostId of REMOTE_HOSTS) {
      expect(reloaded.getWorkspaceSession(hostId)).toEqual(before.byHost[hostId])
    }

    reloaded.flush()
    expect(readPersistedStateJson(dataFile)).toBe(rewritten)
  })

  it('loads an old-serializer file and a new-serializer file to the same state', () => {
    const legacyFile = tempDataFile()
    writeLegacyFile(legacyFile)
    const fromLegacy = openStore(legacyFile)
    fromLegacy.flush()

    const compactFile = tempDataFile()
    writeFileSync(compactFile, readPersistedStateJson(legacyFile))
    const fromCompact = openStore(compactFile)

    expect(fromCompact.getAllWorktreeMeta()).toEqual(fromLegacy.getAllWorktreeMeta())
    expect(fromCompact.getWorkspaceSession()).toEqual(fromLegacy.getWorkspaceSession())
    for (const hostId of REMOTE_HOSTS) {
      expect(fromCompact.getWorkspaceSession(hostId)).toEqual(
        fromLegacy.getWorkspaceSession(hostId)
      )
    }
  })
})
