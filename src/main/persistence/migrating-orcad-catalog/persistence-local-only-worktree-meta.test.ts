import {
  closeTestStores,
  createStore,
  readPersistedStateJson,
  testState
} from '../persistence-test-harness'
// Repo-less floating/setup terminals belong to this machine and must not project onto SSH hosts (#31498).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultPersistedState } from '../../../shared/constants'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { hydrateWorktreeMetaAliasProjection } from '../loading-store/worktree-metadata/worktree-meta-alias-projection'
import { normalizeWorktreeLinkedItemMetadata } from '../tracking-repos/worktree-metadata-normalization'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

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
})
