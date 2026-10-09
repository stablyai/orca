import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../agent-hooks/server'
import {
  clearMigrationUnsupportedPty,
  setMigrationUnsupportedPty
} from '../../agent-hooks/migration-unsupported-pty-state'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { openProfileStateDatabase } from '../profile-state/profile-state-database'
import { readProfileStateRevision } from '../profile-state/profile-state-revision'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const SOURCE_A = makePaneKey('tab-a', '11111111-1111-4111-8111-111111111111')
const TARGET_A = makePaneKey('tab-a2', '22222222-2222-4222-8222-222222222222')
const TARGET_A_2 = makePaneKey('tab-a3', '55555555-5555-4555-8555-555555555555')
const TARGET_A_3 = makePaneKey('tab-a4', '66666666-6666-4666-8666-666666666666')
const SOURCE_B = makePaneKey('tab-b', '33333333-3333-4333-8333-333333333333')
const TARGET_B = makePaneKey('tab-b2', '44444444-4444-4444-8444-444444444444')
const MIGRATION_ENTRY = {
  ptyId: 'pty-legacy',
  reason: 'legacy-numeric-pane-key' as const,
  source: 'local' as const,
  updatedAt: 5
}

afterEach(() => {
  agentHookServer.clearPaneKeyAliasesForPty('pty-a')
  agentHookServer.clearPaneKeyAliasesForPty('pty-b')
  clearMigrationUnsupportedPty(MIGRATION_ENTRY.ptyId)
})

/** Seed two durable aliases, then hold the next alias commit at the given point. */
async function holdAliasCommit(point: 'after-commit' | 'before-failure') {
  const fixture = await createWorkerMaintenanceFixture()
  const { store, authority } = fixture
  agentHookServer.transferPaneAuthority(SOURCE_A, TARGET_A, 'pty-a', 1)
  agentHookServer.transferPaneAuthority(SOURCE_B, TARGET_B, 'pty-b', 1)
  await store.flushPendingOrThrowAsync()
  const started = maintenanceBarrier()
  const release = maintenanceBarrier()
  const write = authority.writeSerializedDomains.bind(authority)
  const writes = vi.spyOn(authority, 'writeSerializedDomains')
  writes.mockImplementationOnce(async (domains) => {
    if (point === 'after-commit') {
      await write(domains)
    }
    started.resolve()
    await release.promise
    if (point === 'before-failure') {
      throw new ProfileStateWriterError('SQLITE_BUSY', 'busy', 'known-failure')
    }
  })
  // Commit A also carries a section no later edit touches, so only restored intent can save it.
  agentHookServer.transferPaneAuthority(TARGET_A, TARGET_A_2, 'pty-a', 2)
  setMigrationUnsupportedPty(MIGRATION_ENTRY)
  const controller = new AbortController()
  const pending = store.flushPendingOrThrowAsync({ signal: controller.signal })
  const settled = pending.catch((error: unknown) => error)
  await started.promise
  // Newer edits arrive while commit A is unacknowledged.
  agentHookServer.transferPaneAuthority(TARGET_A_2, TARGET_A_3, 'pty-a', 3)
  agentHookServer.clearPaneKeyAliasesForPty('pty-b')
  store.setWorkspaceSession(
    { ...getDefaultWorkspaceSession(), activeRepoId: 'remote-repo' },
    'ssh:ssh-1'
  )
  return { ...fixture, writes, controller, release, settled }
}

function expectLatestOwedState(state: {
  legacyPaneKeyAliasEntries?: unknown
  migrationUnsupportedPtyEntries?: unknown
  workspaceSessionsByHostId?: Record<string, unknown>
}): void {
  expect(state.migrationUnsupportedPtyEntries).toEqual([MIGRATION_ENTRY])
  expect(state.legacyPaneKeyAliasEntries).toEqual([
    { ptyId: 'pty-a', legacyPaneKey: SOURCE_A, stablePaneKey: TARGET_A_3, updatedAt: 3 }
  ])
  expect(state.workspaceSessionsByHostId?.['ssh:ssh-1']).toMatchObject({
    activeRepoId: 'remote-repo'
  })
}

describe('profile flush caller cancellation', () => {
  it('keeps newer alias, deletion, and remote edits owed after a delayed alias commit', async () => {
    const { store, readState, writes, controller, release, settled, databaseFile, profileId } =
      await holdAliasCommit('after-commit')
    controller.abort()
    expect(await settled).toMatchObject({ message: expect.stringContaining('aborted') })
    // Commit A is durable, but nothing newer is reported or persisted early.
    expect(readState().legacyPaneKeyAliasEntries).toEqual(
      expect.arrayContaining([expect.objectContaining({ ptyId: 'pty-a', updatedAt: 2 })])
    )
    release.resolve()
    await store.flushPendingOrThrowAsync()
    expectLatestOwedState(readState())
    // A's replacement is not replayed: the drain writes only the newer values.
    expect(writes).toHaveBeenCalledTimes(2)
    const readRevision = () => {
      const opened = openProfileStateDatabase(databaseFile, profileId)
      try {
        return readProfileStateRevision(opened.db)
      } finally {
        opened.db.close()
      }
    }
    const revision = readRevision()
    await store.flushPendingOrThrowAsync()
    expect(readRevision()).toBe(revision)
  })

  it('restores dirty intent after a confirmed failure that held newer edits', async () => {
    const { store, readState, release, settled } = await holdAliasCommit('before-failure')
    release.resolve()
    expect(await settled).toMatchObject({ code: 'SQLITE_BUSY', outcome: 'known-failure' })
    await store.flushPendingOrThrowAsync()
    expectLatestOwedState(readState())
  })

  it('releases a canceled waiter while its admitted write completes and later saving continues', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writeSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      await write(domains)
      started.resolve()
      await release.promise
    })
    const abort = vi.spyOn(authority, 'abort')
    const controller = new AbortController()
    store.updateSettings({ theme: 'dark' })
    const pending = store.flushPendingOrThrowAsync({ signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('aborted')
    let settled = false
    void pending.catch(() => {
      settled = true
    })
    await started.promise
    controller.abort()
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(abort).not.toHaveBeenCalled()
      expect(settled).toBe(true)
      expect(() => authority.assertWritable()).not.toThrow()
    } finally {
      release.resolve()
      await rejected
    }
    await store.runDurableMutation(() => {
      store.updateSettings({ theme: 'light' })
      return { value: undefined }
    })
    expect(readState().settings.theme).toBe('light')
  })

  it('keeps an abandoned write ordered before the final checkpoint', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writeSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      started.resolve()
      await release.promise
      await write(domains)
    })
    const controller = new AbortController()
    store.updateSettings({ theme: 'dark' })
    const abandoned = store.flushPendingOrThrowAsync({ signal: controller.signal })
    const rejected = expect(abandoned).rejects.toThrow('aborted')
    await started.promise
    controller.abort()
    store.getWorkspaceSession().activeTabId = 'shutdown-edit'
    const capture = vi.spyOn(authority, 'writeCompleteSerializedDomains')
    const final = store.flushFinalOrThrowAsync()
    const result = final.catch((error: unknown) => error)
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(capture).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await rejected
    }
    await expect(result).resolves.toBeUndefined()
    expect(readState()).toMatchObject({
      settings: { theme: 'dark' },
      workspaceSession: { activeTabId: 'shutdown-edit' }
    })
  })
})
