import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../shared/agent-session-resume'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  parseOrcadMigrationManifest,
  type OrcadMigrationImportReceipt,
  type OrcadMigrationManifest
} from '../shared/orcad-migration-manifest'
import type { SshTarget } from '../shared/ssh-types'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { computeOrcadMigrationManifestSha256 } from './orcad/orcad-migration-manifest-digest'
import { createStore, testState } from './persistence-test-harness'
import { createOrcadMigrationManifest } from './ssh/orcad-migration-manifest-export'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(() => ({ nth_repo_added: 1 }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf8').slice('encrypted:'.length)
  }
}))
vi.mock('./telemetry/client', () => ({ track: trackMock }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 8
}
const WORKTREE_ID = 'repo-1::/srv/repo-1-worktree'
const TAB_ID = 'tab-sleeping-agent'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-migration-sleeping-agent-'))
  selectStoreRoot('source')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('orcad migration sleeping-agent authority', () => {
  it('rekeys a dormant resume record, commits it locally, and retires only after receipt', () => {
    const source = sourceStore()
    source.setWorkspaceSession(dormantSession(source, sleepingRecord()), `ssh:${TARGET.id}`)
    const manifest = createOrcadMigrationManifest(source, TARGET, {
      migrationId: 'sleeping-agent-transfer'
    })
    const incoming = requiredSleepingRecord(manifest)

    expect(incoming).toMatchObject({
      paneKey: PANE_KEY,
      worktreeId: WORKTREE_ID,
      connectionId: null,
      origin: 'quit',
      providerSession: { key: 'session_id', id: 'codex-session-1' }
    })
    source.beginOrcadMigrationSourceCutover(manifest, 'environment-1')
    source.markOrcadMigrationDestinationCommitted(manifest.migrationId, committedState(manifest))
    source.retireOrcadMigrationSourceCatalog(manifest.migrationId)
    expect(
      source.getWorkspaceSession(`ssh:${TARGET.id}`).sleepingAgentSessionsByPaneKey?.[PANE_KEY]
    ).toBeUndefined()

    selectStoreRoot('destination')
    const destination = createStore()
    destination.stageOrcadMigrationCatalog(manifest)
    destination.commitStagedOrcadMigrationCatalog(manifest)
    expect(destination.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toEqual(
      incoming
    )
  })

  it.each([
    ['cross-target authority', { connectionId: 'ssh-other' }],
    ['orchestration fence', { automaticResumeBlockedBy: 'legacy-orchestration-worker' as const }],
    ['missing live pane', { paneKey: `${TAB_ID}:missing`, origin: 'live' as const }]
  ])('keeps the source fenced for %s', (_label, overrides) => {
    const source = sourceStore()
    const record = sleepingRecord(overrides)
    source.setWorkspaceSession(dormantSession(source, record), `ssh:${TARGET.id}`)
    const manifest = createOrcadMigrationManifest(source, TARGET, {
      migrationId: `blocked-${record.paneKey}-${record.connectionId ?? 'local'}`
    })

    expect(manifest.payload.dormantState?.workspaceSession?.sleepingAgentSessionsByPaneKey).toBe(
      undefined
    )
    expect(() => source.beginOrcadMigrationSourceCutover(manifest, 'environment-1')).toThrow(
      'orcad_migration_source_dependencies_present'
    )
    expect(source.getSshTarget(TARGET.id)?.owner).toBeUndefined()
  })

  it('rejects destination authority and pane-key conflicts before publication', () => {
    const source = sourceStore()
    source.setWorkspaceSession(dormantSession(source, sleepingRecord()), `ssh:${TARGET.id}`)
    const manifest = createOrcadMigrationManifest(source, TARGET, {
      migrationId: 'sleeping-agent-conflicts'
    })

    selectStoreRoot('destination')
    const destination = createStore()
    const invalid = withSleepingRecord(manifest, { connectionId: TARGET.id })
    expect(() => parseOrcadMigrationManifest(invalid)).toThrow(
      'orcad_migration_dormant_workspace_session_agent_authority_invalid'
    )
    destination.setWorkspaceSession(
      dormantSession(destination, sleepingRecord({ connectionId: null, prompt: 'different' }))
    )
    expect(() => destination.stageOrcadMigrationCatalog(manifest)).toThrow(
      `orcad_migration_dormant_id_conflict:workspace_session:sleepingAgentSessionsByPaneKey:${PANE_KEY}`
    )
    expect(destination.getRepos()).toEqual([])
  })
})

function selectStoreRoot(name: string): void {
  testState.dir = join(root, name)
  mkdirSync(testState.dir, { recursive: true })
}

function sourceStore() {
  const store = createStore()
  store.addSshTarget(TARGET)
  store.addRepo({
    id: 'repo-1',
    path: '/srv/repo-1',
    displayName: 'Repository',
    badgeColor: '#737373',
    addedAt: 1,
    connectionId: TARGET.id,
    executionHostId: `ssh:${TARGET.id}`
  })
  return store
}

function dormantSession(
  store: ReturnType<typeof createStore>,
  record: SleepingAgentSessionRecord
): WorkspaceSessionState {
  return {
    ...store.getWorkspaceSession(`ssh:${TARGET.id}`),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: null,
          worktreeId: WORKTREE_ID,
          title: 'Dormant agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  }
}

function sleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> & { automaticResumeBlockedBy?: string } = {}
): SleepingAgentSessionRecord {
  const paneKey = overrides.paneKey ?? PANE_KEY
  return {
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'codex-session-1' },
    prompt: 'continue',
    state: 'done',
    capturedAt: 10,
    updatedAt: 11,
    connectionId: TARGET.id,
    origin: 'quit',
    ...overrides,
    paneKey
  }
}

function requiredSleepingRecord(manifest: OrcadMigrationManifest): SleepingAgentSessionRecord {
  const record =
    manifest.payload.dormantState?.workspaceSession?.sleepingAgentSessionsByPaneKey?.[PANE_KEY]
  if (!record) {
    throw new Error('expected sleeping agent record')
  }
  return record
}

function committedState(manifest: OrcadMigrationManifest) {
  return {
    state: 'committed' as const,
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    receipt: receipt(manifest)
  }
}

function receipt(manifest: OrcadMigrationManifest): OrcadMigrationImportReceipt {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    source: manifest.source,
    importedAt: '2026-08-30T12:03:00.000Z',
    repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
    projectGroupIds: [],
    folderWorkspaceIds: []
  }
}

function withSleepingRecord(
  manifest: OrcadMigrationManifest,
  overrides: Partial<SleepingAgentSessionRecord>
): OrcadMigrationManifest {
  const candidate = structuredClone(manifest)
  const record = requiredSleepingRecord(candidate)
  Object.assign(record, overrides)
  const { manifestSha256: _digest, ...unsigned } = candidate
  return { ...unsigned, manifestSha256: computeOrcadMigrationManifestSha256(unsigned) }
}
