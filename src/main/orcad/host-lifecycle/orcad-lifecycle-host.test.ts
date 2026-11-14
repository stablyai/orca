import { OrcadProfileShutdown } from '../host-runtime/orcad-profile-shutdown'
import { Store } from '../../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from '../../persistence/persistence-test-harness'
import { readFile } from 'node:fs/promises'
import { holdRemovalMetadata } from '../../workspaces/removal/worktree-removal-lifetime.test-fixtures'
import { readWorktreeRemovalRecords } from '../../workspaces/removal/worktree-removal-records'
import { _resetPendingWorktreeRemovalsForTests } from '../../workspaces/removal/worktree-background-removal'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../browser-providers/orcad-browser-startup', () => ({
  startOrcadBrowserProvider: () => ({ ready: Promise.resolve(), stop: async () => {} })
}))

import { ORCAD_LOCK_FILE_NAME } from '../instance-lock/orcad-instance-lock'
import { worktreeRemovalLifetime } from '../../workspaces/removal/worktree-removal-lifetime'
import { startOrcadWithHost } from './orcad-lifecycle'

const roots: string[] = []
afterEach(async () => {
  await closeTestStores()
  vi.restoreAllMocks()
  vi.useRealTimers()
  _resetPendingWorktreeRemovalsForTests()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-lifecycle-host-'))
  roots.push(root)
  return root
}

describe('startOrcadWithHost', () => {
  it('keeps the instance lock when a runtime writer could not be stopped', async () => {
    const root = dataRoot()
    const failure = new Error('profile writer still running')
    const handle = await startOrcadWithHost(
      root,
      async (registerCleanup) => {
        registerCleanup(() => {
          throw failure
        })
        return {}
      },
      () => {}
    )
    await expect(handle.stop()).rejects.toBe(failure)
    expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(true)
  })
})

it('joins successful removal metadata and journal before profile ownership is released', async () => {
  vi.useFakeTimers()
  const root = dataRoot()
  const profile = new OrcadProfileShutdown()
  const dataFile = join(root, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  profile.store = store
  await profile.store.flushPendingOrThrowAsync({ fullCheckpoint: true })
  store.getWorkspaceSession().activeTabId = 'before-stop'
  const savedTab = () => JSON.parse(readPersistedStateJson(dataFile)).workspaceSession.activeTabId
  let pending!: Awaited<ReturnType<typeof holdRemovalMetadata>>
  let transportStopped!: () => void
  const transport = new Promise<void>((resolve) => {
    transportStopped = resolve
  })
  let checkpointing: Promise<void> | undefined
  const handle = await startOrcadWithHost(
    root,
    async (registerCleanup) => {
      registerCleanup(profile.finalize)
      registerCleanup(() => worktreeRemovalLifetime.close())
      pending = await holdRemovalMetadata(root, () => {
        store.getWorkspaceSession().activeTabId = 'after-delete'
      })
      registerCleanup(async () => {
        transportStopped()
      })
      return {}
    },
    () => {},
    () => (checkpointing = profile.checkpoint())
  )
  const stopping = handle.stop()
  await transport
  expect(() => worktreeRemovalLifetime.acquirePreparation()).toThrow('Orca is stopping')
  expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(true)
  expect(await readWorktreeRemovalRecords(root)).toHaveLength(1)
  await checkpointing
  expect(savedTab()).toBe('before-stop')
  pending.release()
  await stopping
  await pending.result
  expect(await readFile(join(root, 'metadata-finished'), 'utf8')).toBe('removed')
  expect(await readWorktreeRemovalRecords(root)).toEqual([])
  expect(savedTab()).toBe('after-delete')
  expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(false)
})
