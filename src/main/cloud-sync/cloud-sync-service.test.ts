import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudSyncView } from '../../shared/cloud-sync/cloud-sync-contract'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { createFakeVm } from './cloud-sync-fake-vm.test-support'
import { createCloudSyncService } from './cloud-sync-service'
import { createCloudSyncStore } from './cloud-sync-store'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function runtime(status: EphemeralVmRuntimeRecord['status']): EphemeralVmRuntimeRecord {
  return {
    id: 'rt-1',
    recipeId: 'orca-cloud',
    recipe: { id: 'orca-cloud', name: 'Orca Cloud', create: 'x', provider: 'orca-cloud' },
    repoPath: '/Users/me/src/Hello-World',
    workspaceId: 'ws',
    workspaceName: 'my-ws',
    runtimeEnvironmentId: 'env-1',
    status,
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1
  }
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'cloud-sync-home-'))
  const userData = await mkdtemp(join(tmpdir(), 'cloud-sync-ud-'))
  dirs.push(home, userData)
  const vm = createFakeVm()
  vm.write('.context/plan.md', 'plan')
  vm.write('src/a.ts', 'a')
  let record = runtime('running')
  let archived = false
  const views: CloudSyncView[] = []
  const opened: string[] = []
  const service = createCloudSyncService({
    store: createCloudSyncStore(userData),
    listRuntimes: () => [record],
    callFor: () => vm.call,
    watchFor: () => vm.subscribe,
    isArchived: async () => archived,
    broadcast: (view) => views.push(view),
    openPath: async (path) => {
      opened.push(path)
      return true
    },
    home,
    log: () => undefined
  })
  const folder = join(home, 'orca', 'cloud', 'Hello-World', 'my-ws')
  const synced = async (): Promise<void> => {
    await vi.waitFor(() => expect(views.at(-1)?.phase).toBe('synced'))
  }
  return {
    vm,
    service,
    folder,
    views,
    opened,
    synced,
    setStatus: (status: EphemeralVmRuntimeRecord['status']) => {
      record = runtime(status)
    },
    setArchived: (value: boolean) => {
      archived = value
    }
  }
}

describe('cloud sync service', () => {
  it('syncs .context by default into ~/orca/cloud/<repository>/<workspace>', async () => {
    const t = await setup()
    await t.service.reconcile()
    await t.synced()
    expect(await readFile(join(t.folder, '.context/plan.md'), 'utf8')).toBe('plan')
    const view = await t.service.getState('ws')
    expect(view).toMatchObject({
      choice: { context: true, mirror: false },
      displayPath: '~/orca/cloud/Hello-World/my-ws/.context'
    })
    await t.service.openFolder('ws')
    expect(t.opened).toEqual([join(t.folder, '.context')])
    await t.service.dispose()
  })

  it('opens the workspace folder once the mirror is on', async () => {
    const t = await setup()
    await t.service.reconcile()
    await t.synced()
    const view = await t.service.setChoice('ws', { mirror: true })
    expect(view?.displayPath).toBe('~/orca/cloud/Hello-World/my-ws')
    await vi.waitFor(async () =>
      expect(await readFile(join(t.folder, 'src/a.ts'), 'utf8')).toBe('a')
    )
    await t.service.dispose()
  })

  it('asleep: stops, keeps the copy and reports waiting with the last sync', async () => {
    const t = await setup()
    await t.service.reconcile()
    await t.synced()
    t.setStatus('suspended')
    await t.service.reconcile()
    expect(t.views.at(-1)).toMatchObject({ phase: 'waiting' })
    expect(t.views.at(-1)?.lastSyncedAt).not.toBeNull()
    expect(t.vm.openWatches()).toBe(0)
    expect(await readFile(join(t.folder, '.context/plan.md'), 'utf8')).toBe('plan')
    await t.service.dispose()
  })

  it('archived: removes the copy it made but not files someone added', async () => {
    const t = await setup()
    await t.service.reconcile()
    await t.synced()
    await writeFile(join(t.folder, '.context/mine.txt'), 'mine')
    expect(await t.service.removalPreview('ws')).toEqual({ hasLocalCopy: true, editedHere: 0 })
    t.setStatus('suspended')
    await t.service.noteArchived('ws')
    await expect(stat(join(t.folder, '.context/plan.md'))).rejects.toThrow()
    expect(await readFile(join(t.folder, '.context/mine.txt'), 'utf8')).toBe('mine')
    await t.service.dispose()
  })

  it('archived elsewhere is found on the slow check while asleep', async () => {
    const t = await setup()
    await t.service.reconcile()
    await t.synced()
    t.setStatus('suspended')
    t.setArchived(true)
    await t.service.reconcile()
    await expect(stat(t.folder)).rejects.toThrow()
    await t.service.dispose()
  })

  it('deleted: the whole folder goes', async () => {
    const t = await setup()
    await t.service.reconcile()
    await t.synced()
    t.setStatus('cleaned')
    await t.service.reconcile()
    await expect(stat(t.folder)).rejects.toThrow()
    await t.service.dispose()
  })

  it('turning both off removes the copy', async () => {
    const t = await setup()
    await t.service.reconcile()
    await t.synced()
    const view = await t.service.setChoice('ws', { context: false })
    expect(view?.phase).toBe('off')
    await expect(stat(join(t.folder, '.context/plan.md'))).rejects.toThrow()
    await t.service.dispose()
  })
})
