import { closeTestStores, createStore, dataFile, testState } from './persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentHookServer } from './agent-hooks/server'
import {
  clearMigrationUnsupportedPty,
  setMigrationUnsupportedPty,
  setMigrationUnsupportedPtyPersistenceListener
} from './agent-hooks/migration-unsupported-pty-state'
import { StateSerializationSecretHandlingOperations } from './persistence/loading-store/state-serialization-secret-handling'
import {
  openProfileStateDatabaseReadOnly,
  profileStateDatabaseFile
} from './persistence/profile-state/profile-state-database'
import { ProfileStateSqliteAuthority } from './persistence/profile-state/profile-state-sqlite-authority'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { makePaneKey } from '../shared/stable-pane-id'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const SOURCE = makePaneKey('tab-source', '11111111-1111-4111-8111-111111111111')
const TARGET = makePaneKey('tab-target', '22222222-2222-4222-8222-222222222222')
const FINAL = makePaneKey('tab-final', '33333333-3333-4333-8333-333333333333')
const migrationEntry = {
  ptyId: 'ssh:ssh-1@@legacy-pty',
  worktreeId: 'repo-1::/worktree',
  tabId: 'tab-1',
  reason: 'legacy-numeric-pane-key' as const,
  source: 'ssh' as const,
  updatedAt: 1_700_000_000_123
}

type DocumentRow = { domain: string; payload: string; revision: number }

function isDocumentRow(row: unknown): row is DocumentRow {
  return (
    typeof row === 'object' &&
    row !== null &&
    'domain' in row &&
    typeof row.domain === 'string' &&
    'payload' in row &&
    typeof row.payload === 'string' &&
    'revision' in row &&
    typeof row.revision === 'number'
  )
}

/** Reads every document in one statement, independent of the Store under test. */
function readDocuments(): Map<string, DocumentRow> {
  const opened = openProfileStateDatabaseReadOnly(
    profileStateDatabaseFile(dirname(dataFile())),
    'persistence-test'
  )
  try {
    const rows = opened.db
      .prepare('SELECT domain, payload, revision FROM profile_state_documents')
      .all()
    return new Map(rows.filter(isDocumentRow).map((row) => [row.domain, row]))
  } finally {
    opened.db.close()
  }
}

async function runBackgroundSave(store: Awaited<ReturnType<typeof createStore>>): Promise<void> {
  vi.advanceTimersByTime(1_000)
  await store.waitForPendingWrite()
}

describe('pane alias and migration listeners save only their sections', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-alias-saves-'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await closeTestStores()
    agentHookServer.setPaneKeyAliasPersistenceListener(null)
    setMigrationUnsupportedPtyPersistenceListener(null)
    agentHookServer.retirePaneAuthority(TARGET)
    for (const ptyId of ['pty-1', 'ssh:ssh-1@@pty-1', 'local-pty']) {
      agentHookServer.clearPaneKeyAliasesForPty(ptyId)
    }
    clearMigrationUnsupportedPty(migrationEntry.ptyId)
    rmSync(testState.dir, { recursive: true, force: true })
  })

  async function durableBaseline() {
    const store = await createStore()
    store.flushOrThrow()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fullPreparation = vi.spyOn(
      StateSerializationSecretHandlingOperations.prototype,
      'buildStateToSave'
    )
    const domainWrites = vi.spyOn(ProfileStateSqliteAuthority.prototype, 'writeSerializedDomains')
    return { store, fullPreparation, domainWrites, before: readDocuments() }
  }

  function expectOnlyChanged(
    before: Map<string, DocumentRow>,
    after: Map<string, DocumentRow>,
    changed: readonly string[]
  ): void {
    for (const [domain, row] of before) {
      if (!changed.includes(domain)) {
        expect(after.get(domain), domain).toEqual(row)
      }
    }
  }

  it('writes an alias transfer as its own section with timestamps intact', async () => {
    const { store, fullPreparation, domainWrites, before } = await durableBaseline()
    agentHookServer.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 1_700_000_000_456)
    await runBackgroundSave(store)

    expect(fullPreparation).not.toHaveBeenCalled()
    expect(domainWrites.mock.calls.map(([replacements]) => replacements)).toEqual([
      [{ domain: 'legacyPaneKeyAliasEntries', payload: expect.any(String) }]
    ])
    const after = readDocuments()
    expect(JSON.parse(after.get('legacyPaneKeyAliasEntries')?.payload ?? 'null')).toEqual([
      { ptyId: 'pty-1', legacyPaneKey: SOURCE, stablePaneKey: TARGET, updatedAt: 1_700_000_000_456 }
    ])
    expectOnlyChanged(before, after, ['legacyPaneKeyAliasEntries'])
  })

  it('saves a chained alias update', async () => {
    const { store } = await durableBaseline()
    agentHookServer.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10)
    await runBackgroundSave(store)
    agentHookServer.transferPaneAuthority(TARGET, FINAL, 'pty-1', 20)
    await runBackgroundSave(store)

    const payload = readDocuments().get('legacyPaneKeyAliasEntries')?.payload ?? 'null'
    expect(JSON.parse(payload)).toEqual([
      expect.objectContaining({ stablePaneKey: FINAL, updatedAt: 20 })
    ])
  })

  it('writes an empty migration list as an empty array, not a deletion', async () => {
    const { store, fullPreparation, domainWrites, before } = await durableBaseline()
    setMigrationUnsupportedPty(migrationEntry)
    await runBackgroundSave(store)
    expect(
      JSON.parse(readDocuments().get('migrationUnsupportedPtyEntries')?.payload ?? '')
    ).toEqual([migrationEntry])
    clearMigrationUnsupportedPty(migrationEntry.ptyId)
    await runBackgroundSave(store)

    expect(fullPreparation).not.toHaveBeenCalled()
    expect(domainWrites.mock.calls.map(([replacements]) => replacements)).toEqual([
      [{ domain: 'migrationUnsupportedPtyEntries', payload: JSON.stringify([migrationEntry]) }],
      [{ domain: 'migrationUnsupportedPtyEntries', payload: '[]' }]
    ])
    const after = readDocuments()
    expect(after.get('migrationUnsupportedPtyEntries')?.payload).toBe('[]')
    expectOnlyChanged(before, after, ['migrationUnsupportedPtyEntries'])
  })

  it('commits a co-batched SSH host session with the alias in one transaction', async () => {
    const { store, fullPreparation, domainWrites, before } = await durableBaseline()
    const remoteSession = { ...getDefaultWorkspaceSession(), activeRepoId: 'remote-repo' }
    store.setWorkspaceSession(remoteSession, 'ssh:ssh-1')
    agentHookServer.transferPaneAuthority(SOURCE, TARGET, 'ssh:ssh-1@@pty-1', 30)
    await runBackgroundSave(store)

    expect(fullPreparation).not.toHaveBeenCalled()
    expect(domainWrites).toHaveBeenCalledOnce()
    expect(domainWrites.mock.calls[0]?.[0].map(({ domain }) => domain).toSorted()).toEqual([
      'legacyPaneKeyAliasEntries',
      'workspaceSessionsByHostId'
    ])
    const after = readDocuments()
    const sessions = JSON.parse(after.get('workspaceSessionsByHostId')?.payload ?? '{}')
    expect(sessions['ssh:ssh-1']).toMatchObject({ activeRepoId: 'remote-repo' })
    expect(after.get('workspaceSessionsByHostId')?.revision).toBe(
      after.get('legacyPaneKeyAliasEntries')?.revision
    )
    expectOnlyChanged(before, after, ['legacyPaneKeyAliasEntries', 'workspaceSessionsByHostId'])
  })

  it('keeps an unscoped save full when an alias joins it', async () => {
    const { store, fullPreparation, domainWrites } = await durableBaseline()
    store.setMobileClientTabSelections({})
    agentHookServer.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 40)
    await runBackgroundSave(store)

    expect(fullPreparation).toHaveBeenCalled()
    expect(domainWrites).not.toHaveBeenCalled()
    const after = readDocuments()
    expect(after.get('mobileClientTabSelectionsByDeviceId')?.payload).toBe('{}')
    expect(JSON.parse(after.get('legacyPaneKeyAliasEntries')?.payload ?? '[]')).toEqual([
      expect.objectContaining({ stablePaneKey: TARGET, updatedAt: 40 })
    ])
  })

  it('persists a renderer session publish and the alias it creates from one background save', async () => {
    const { store, before } = await durableBaseline()
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'local-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'pane:1' },
          activeLeafId: 'pane:1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'pane:1': 'local-pty' }
        }
      }
    })
    const root = store.getWorkspaceSession().terminalLayoutsByTabId.tab1?.root
    const stableLeafId = root?.type === 'leaf' ? root.leafId : null
    expect(stableLeafId).not.toBe('pane:1')
    await runBackgroundSave(store)

    const after = readDocuments()
    const session = JSON.parse(after.get('workspaceSession')?.payload ?? '{}')
    expect(session).toMatchObject({
      activeTabId: 'tab1',
      terminalLayoutsByTabId: {
        tab1: {
          root: { leafId: stableLeafId },
          ptyIdsByLeafId: { [stableLeafId ?? '']: 'local-pty' }
        }
      }
    })
    expect(JSON.parse(after.get('legacyPaneKeyAliasEntries')?.payload ?? '[]')).toEqual([
      expect.objectContaining({
        ptyId: 'local-pty',
        legacyPaneKey: 'tab1:1',
        stablePaneKey: makePaneKey('tab1', stableLeafId ?? '')
      })
    ])
    expectOnlyChanged(before, after, ['legacyPaneKeyAliasEntries', 'workspaceSession'])
  })
})
