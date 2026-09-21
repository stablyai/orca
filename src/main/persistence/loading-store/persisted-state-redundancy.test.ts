/**
 * The store file re-serializes in full on a 1s debounce and re-parses in full at launch, so every
 * byte it carries is paid for on both. Two kinds of byte were provably redundant on a 4.2 MB real
 * install: `"linked*":null` slots that `mergeWorktreeMetaForWrite` materializes on every metadata
 * row, and copies of local-owned global session fields inside non-local host partitions.
 *
 * These tests drive the real Store over a fixture sized like that install (10 hosts, 1,200 metadata
 * rows, 200 browser history entries) and pin the only property that makes the omission safe: a file
 * written by the OLD serializer and a file written by the NEW one load to the same in-memory state.
 */
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
/** local + 9 more, matching the reporting install. */
const REMOTE_HOSTS = Array.from({ length: 9 }, (_, index) => `runtime:env-${index}`)
/** The measured shape: 3 of the 9 held a byte-identical replica of local's history. */
const HOSTS_WITH_REPLICA = REMOTE_HOSTS.slice(0, 3)
/** 1 row in 40 carries a real link, so its slots must stay written. */
const LINKED_ROW_STRIDE = 40
/** Recent enough that the 30-day stale-metadata GC leaves the fixture alone. */
const RECENTLY = Date.now()

const stores: InstanceType<typeof Store>[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  vi.restoreAllMocks()
})

function openStore(dataFile: string): InstanceType<typeof Store> {
  const store = new Store({ dataFile })
  stores.push(store)
  return store
}

function tempDataFile(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'orca-redundancy-'))), 'orca-data.json')
}

/** A row exactly as the OLD write path left it: every default slot materialized. */
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

/** A file in the pre-change shape: materialized metadata defaults, and local's global session
 *  fields replicated into the host partitions the split used to seed from one shared template. */
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

/** Inverse of everything this change does, applied to a compact file: what the old serializer
 *  would have written for the same state. */
function reexpandToLegacyShape(state: PersistedState): PersistedState {
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

    // One load+flush first, so the baseline is not comparing against the one-time settings
    // migrations a synthetic fixture triggers (same reason as state-write-round-trip.test.ts).
    openStore(dataFile).flush()

    const loaded = openStore(dataFile)
    const before = {
      meta: structuredClone(loaded.getAllWorktreeMeta()),
      local: structuredClone(loaded.getWorkspaceSession()),
      byHost: Object.fromEntries(
        REMOTE_HOSTS.map((hostId) => [hostId, structuredClone(loaded.getWorkspaceSession(hostId))])
      )
    }
    // The refill ran, so absence never reaches a consumer as `undefined`.
    for (const meta of Object.values(before.meta)) {
      for (const field of Object.keys(WORKTREE_META_PERSISTED_DEFAULTS)) {
        expect(meta).toHaveProperty(field)
      }
    }

    loaded.flush()
    const rewritten = readFileSync(dataFile, 'utf-8')

    // Only rows that actually hold a value still carry a slot: linkedPR + isPinned, 1 row in 40.
    expect(defaultedSlotOccurrences(rewritten)).toBe(
      (Math.ceil(META_ROWS / LINKED_ROW_STRIDE) + Math.ceil(IDENTITY_ROWS / LINKED_ROW_STRIDE)) * 2
    )
    // And no non-local partition carries a global the merge only ever reads off 'local'.
    const onDisk = JSON.parse(rewritten) as PersistedState
    for (const hostId of REMOTE_HOSTS) {
      for (const field of HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS) {
        expect(onDisk.workspaceSessionsByHostId?.[hostId]).not.toHaveProperty(field)
      }
    }
    // Apples to apples: re-expand the file we just wrote back into the old shape and compare, so
    // the number is the redundancy alone and not the settings defaults a synthetic fixture lacks.
    expect(Buffer.byteLength(rewritten)).toBeLessThan(
      Buffer.byteLength(JSON.stringify(reexpandToLegacyShape(onDisk))) * 0.6
    )

    // load(save(state)) deep-equals the pre-save state for every field touched.
    const reloaded = openStore(dataFile)
    expect(reloaded.getAllWorktreeMeta()).toEqual(before.meta)
    expect(reloaded.getWorkspaceSession()).toEqual(before.local)
    for (const hostId of REMOTE_HOSTS) {
      expect(reloaded.getWorkspaceSession(hostId)).toEqual(before.byHost[hostId])
    }

    // A quiet app does not rewrite the file with new content on the next flush.
    reloaded.flush()
    expect(readFileSync(dataFile, 'utf-8')).toBe(rewritten)
  })

  it('loads an old-serializer file and a new-serializer file to the same state', () => {
    const legacyFile = tempDataFile()
    writeLegacyFile(legacyFile)
    const fromLegacy = openStore(legacyFile)
    // Writing it back produces the new, compact shape in place.
    fromLegacy.flush()

    const compactFile = tempDataFile()
    writeFileSync(compactFile, readFileSync(legacyFile))
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
