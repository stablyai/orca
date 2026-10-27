import {
  closeTestStores,
  createStore,
  readPersistedStateJson,
  testState
} from './persistence/persistence-test-harness'
// Repo-less floating/setup terminals belong to this machine and must not project onto SSH hosts (#31498).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultPersistedState } from '../shared/constants'
import {
  composeWorktreeHostIdentity,
  hostWorktreeTarget
} from '../shared/worktree/host-qualified-identity'
import { canonicalWorktreeIdentity } from '../shared/worktree/identity'
import { resolveWorktreeMetaOwner } from './persistence/host-qualified-worktree-meta'
import { hydrateWorktreeMetaAliasProjection } from './persistence/loading-store/worktree-meta-alias-projection'
import { normalizeWorktreeLinkedItemMetadata } from './persistence/tracking-repos/worktree-metadata-normalization'
import { collectDependentStateBlockers } from './ssh/targets/ssh-target-orcad-dependents'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const SSH_HOST = 'ssh:ssh-1'

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const floatingRow = {
  instanceId: INSTANCE_ID,
  displayName: '',
  comment: '',
  isUnread: false,
  sortOrder: 1,
  lastActivityAt: 1,
  workspaceStatus: 'in-progress'
}

function createUpgradedStore(metadata: Record<string, unknown> = {}) {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      worktreeMeta: { [FLOATING_TERMINAL_WORKTREE_ID]: floatingRow },
      ...metadata
    }),
    'utf-8'
  )
  return createStore()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-local-only-worktree-meta-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('local-only workspace metadata', () => {
  it('stamps a pre-existing unstamped floating terminal row local on load', () => {
    const store = createUpgradedStore()
    expect(store.getWorktreeMeta(FLOATING_TERMINAL_WORKTREE_ID)?.hostId).toBe('local')
    expect(store.getAllWorktreeMetaForHost(SSH_HOST)).not.toHaveProperty(
      FLOATING_TERMINAL_WORKTREE_ID
    )
    expect(store.getWorktreeMetaForHost(FLOATING_TERMINAL_WORKTREE_ID, 'local')?.sortOrder).toBe(1)
    expect(collectDependentStateBlockers(store, 'ssh-1')).toEqual([])
  })

  it('moves a floating terminal row an older build stamped for an SSH host back to this machine', () => {
    const remoteKey = canonicalWorktreeIdentity({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      executionHostId: SSH_HOST,
      instanceId: INSTANCE_ID
    })
    const remoteRow = { ...floatingRow, hostId: SSH_HOST }
    const store = createUpgradedStore({
      worktreeMeta: { [FLOATING_TERMINAL_WORKTREE_ID]: remoteRow },
      worktreeMetaByIdentity: { [remoteKey]: remoteRow },
      worktreeIdentityAliases: {
        [composeWorktreeHostIdentity(SSH_HOST, FLOATING_TERMINAL_WORKTREE_ID)]: [remoteKey]
      }
    })
    expect(store.getAllWorktreeMetaForHost(SSH_HOST)).toEqual({})
    expect(store.getWorktreeMetaForHost(FLOATING_TERMINAL_WORKTREE_ID, 'local')).toMatchObject({
      hostId: 'local',
      instanceId: INSTANCE_ID,
      workspaceStatus: 'in-progress'
    })
    expect(collectDependentStateBlockers(store, 'ssh-1')).toEqual([])
  })

  it('keeps a local floating terminal row over a staler remote copy, and settles in one load', async () => {
    const remoteKey = canonicalWorktreeIdentity({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      executionHostId: SSH_HOST,
      instanceId: INSTANCE_ID
    })
    const localRow = { ...floatingRow, hostId: 'local', lastActivityAt: 5, workspaceStatus: 'done' }
    createUpgradedStore({
      worktreeMeta: { [FLOATING_TERMINAL_WORKTREE_ID]: localRow },
      worktreeMetaByIdentity: { [remoteKey]: { ...floatingRow, hostId: SSH_HOST } },
      worktreeIdentityAliases: {
        [composeWorktreeHostIdentity(SSH_HOST, FLOATING_TERMINAL_WORKTREE_ID)]: [remoteKey]
      }
    }).flush()
    await closeTestStores()
    const saved = JSON.parse(readPersistedStateJson())
    hydrateWorktreeMetaAliasProjection(saved)
    expect(normalizeWorktreeLinkedItemMetadata(saved)).toBe(false)

    const reloaded = createStore()
    expect(
      reloaded.getAllWorktreeMetaForHost('local')[FLOATING_TERMINAL_WORKTREE_ID]
    ).toMatchObject({ hostId: 'local', lastActivityAt: 5, workspaceStatus: 'done' })
    expect(reloaded.getAllWorktreeMetaForHost(SSH_HOST)).toEqual({})
  })

  it('owns a floating terminal row on this machine before any row exists', () => {
    expect(
      resolveWorktreeMetaOwner(
        { getRepos: () => [], getWorktreeMeta: () => undefined },
        FLOATING_TERMINAL_WORKTREE_ID
      )?.hostId
    ).toBe('local')
  })

  it('lands every floating terminal write on this machine, whichever host the caller named', () => {
    const store = createUpgradedStore()
    expect(resolveWorktreeMetaOwner(store, FLOATING_TERMINAL_WORKTREE_ID)?.hostId).toBe('local')
    store.setWorktreeMeta(
      hostWorktreeTarget({ id: FLOATING_TERMINAL_WORKTREE_ID, hostId: SSH_HOST }),
      {
        isUnread: true
      }
    )
    expect(store.getAllWorktreeMetaForHost('local')[FLOATING_TERMINAL_WORKTREE_ID]).toMatchObject({
      hostId: 'local',
      isUnread: true
    })
    expect(store.getAllWorktreeMetaForHost(SSH_HOST)).toEqual({})
    expect(collectDependentStateBlockers(store, 'ssh-1')).toEqual([])
  })
})
