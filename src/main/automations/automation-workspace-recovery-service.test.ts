import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson,
  writePersistedStateJson
} from '../persistence-test-harness'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { AutomationService } from './service'
import type { AutomationWorkspaceOperations } from './automation-workspace-recovery'

const testState = { dir: '' }
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const NOW = Date.UTC(2026, 8, 1, 9)
const OLD_ID = 'repo-1::/repo/removed'
const NEW_ID = 'repo-1::/repo/replacement'
const UNVERIFIABLE = 'The automation workspace could not be verified on its host.'

async function openStore() {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

async function fixture() {
  const store = await openStore()
  store.addRepo({
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: 'blue',
    addedAt: 1
  })
  store.setWorktreeMeta(OLD_ID, {
    displayName: 'Original',
    hostId: 'local',
    baseRef: 'origin/main'
  })
  const automation = store.createAutomation({
    name: 'Checks',
    prompt: 'Check changes',
    agentId: 'codex',
    projectId: 'repo-1',
    workspaceMode: 'existing',
    workspaceId: OLD_ID,
    reuseSession: true,
    timezone: 'UTC',
    rrule: 'FREQ=HOURLY;INTERVAL=1',
    dtstart: NOW - 3_600_000
  })
  vi.setSystemTime(NOW - 60_000)
  const previous = store.createAutomationRun(automation, NOW - 60_000)
  store.updateAutomationRun({ runId: previous.id, status: 'completed', workspaceId: OLD_ID })
  vi.setSystemTime(NOW)
  store.removeWorktreeMeta(OLD_ID, 'local')
  const probe = vi.fn<AutomationWorkspaceOperations['probe']>(async (current) => {
    const id = current.workspaceId
    const meta = id ? store.getWorktreeMeta(id) : undefined
    return id && meta
      ? { kind: 'available', workspace: { id, displayName: meta.displayName } }
      : { kind: 'missing' }
  })
  const create = vi.fn<AutomationWorkspaceOperations['create']>(async () => {
    store.setWorktreeMeta(NEW_ID, {
      displayName: 'Replacement',
      hostId: 'local',
      baseRef: 'origin/main'
    })
    return { id: NEW_ID, displayName: 'Replacement' }
  })
  const dispatcher = vi.fn(async (request: { automation: { workspaceId: string | null } }) => {
    const persisted = JSON.parse(readPersistedStateJson(join(testState.dir, 'orca-data.json')))
    expect(persisted.automations[0].workspaceId).toBe(NEW_ID)
    return { workspaceId: request.automation.workspaceId ?? '', terminalSessionId: 'run-tab' }
  })
  const published = vi.fn()
  const service = new AutomationService(store, {
    workspaceOperations: { probe, create },
    headlessDispatcher: dispatcher,
    onAutomationsChanged: published
  })
  return { store, automation, previous, probe, create, dispatcher, published, service }
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-recovery-'))
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(async () => {
  await closeTestStores()
  vi.useRealTimers()
  removeTreeSync(testState.dir)
})

describe('automation workspace recovery through the owning service', () => {
  it('saves one replacement before launching, keeps history, and reuses it on the next run', async () => {
    const f = await fixture()
    const first = await f.service.runNow(f.automation.id)
    vi.setSystemTime(NOW + 1000)
    const second = await f.service.runNow(f.automation.id)
    expect([first, second]).toEqual([
      expect.objectContaining({
        status: 'dispatched',
        workspaceId: NEW_ID,
        workspaceDisplayName: 'Replacement'
      }),
      expect.objectContaining({ status: 'dispatched', workspaceId: NEW_ID })
    ])
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.dispatcher).toHaveBeenCalledTimes(2)
    expect(f.store.listAutomations()[0]).toMatchObject({
      workspaceMode: 'existing',
      workspaceId: NEW_ID,
      reuseSession: true,
      workspaceRecovery: { kind: 'worktree', baseBranch: 'origin/main' }
    })
    expect(f.store.listAutomationRuns(f.automation.id)).toContainEqual(
      expect.objectContaining({ id: f.previous.id, status: 'completed', workspaceId: OLD_ID })
    )
    expect(f.published).toHaveBeenCalledWith({ reason: 'definition', selector: { kind: 'self' } })
    f.service.stop()
  })

  it('retains the replacement across a store reload', async () => {
    const f = await fixture()
    const run = await f.service.runNow(f.automation.id)
    f.service.stop()
    await f.store.freezeWritesAsync()
    const restored = await openStore()
    expect(restored.listAutomations()[0]).toMatchObject({ workspaceId: NEW_ID, reuseSession: true })
    expect(restored.listAutomationRuns(f.automation.id)).toContainEqual(
      expect.objectContaining({ id: run.id, workspaceId: NEW_ID })
    )
  })

  it('does not replace an unverifiable workspace and folds repeated scheduled refusals', async () => {
    const f = await fixture()
    f.probe.mockResolvedValue({ kind: 'unverifiable', error: UNVERIFIABLE })
    for (const hour of [1, 2, 3]) {
      const before = f.store.listAutomations()[0].nextRunAt
      vi.setSystemTime(NOW + hour * 3_600_000)
      f.service.setRendererReady()
      await vi.waitFor(() => {
        const persisted = JSON.parse(readPersistedStateJson(join(testState.dir, 'orca-data.json')))
        expect(persisted.automations[0].nextRunAt).toBeGreaterThan(before)
      })
    }
    const runs = f.store.listAutomationRuns(f.automation.id)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: UNVERIFIABLE,
      occurrenceCount: 3
    })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.dispatcher).not.toHaveBeenCalled()
    expect(f.store.listAutomations()[0].workspaceId).toBe(OLD_ID)
    f.service.stop()
  })

  it('claims a concurrent occurrence once, including its replacement', async () => {
    const f = await fixture()
    const runs = await Promise.all([
      f.service.runNow(f.automation.id),
      f.service.runNow(f.automation.id)
    ])
    expect(new Set(runs.map((run) => run.id)).size).toBe(1)
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.dispatcher).toHaveBeenCalledOnce()
    f.service.stop()
  })

  it('does not overwrite an edit made while workspace creation is in flight', async () => {
    const f = await fixture()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.create.mockImplementation(async () => {
      started.resolve()
      await release.promise
      return { id: NEW_ID, displayName: 'Replacement' }
    })
    const attempt = f.service.runNow(f.automation.id)
    await started.promise
    f.store.updateAutomation(f.automation.id, { workspaceId: 'repo-1::/repo/user-choice' })
    release.resolve()
    expect(await attempt).toMatchObject({
      status: 'skipped_unavailable',
      error: 'The automation changed before this run could launch.'
    })
    expect(f.store.listAutomations()[0].workspaceId).toBe('repo-1::/repo/user-choice')
    expect(f.dispatcher).not.toHaveBeenCalled()
    f.service.stop()
  })

  it('never starts an agent if the replacement cannot be saved durably', async () => {
    const f = await fixture()
    const originalCreate = f.create.getMockImplementation()
    f.create.mockImplementation(async (...args) => {
      if (!originalCreate) {
        throw new Error('Missing creation fixture')
      }
      const workspace = await originalCreate(...args)
      vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk full'))
      return workspace
    })
    expect(await f.service.runNow(f.automation.id)).toMatchObject({
      status: 'skipped_unavailable',
      error: 'disk full'
    })
    expect(f.dispatcher).not.toHaveBeenCalled()
    f.service.stop()
  })

  it('does not return a finished run to dispatching while the replacement is being saved', async () => {
    const f = await fixture()
    const blocked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const flush = f.store.flushPendingOrThrowAsync.bind(f.store)
    const create = f.create.getMockImplementation()
    f.create.mockImplementation(async (...args) => {
      if (!create) {
        throw new Error('Missing creation fixture')
      }
      const workspace = await create(...args)
      vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockImplementationOnce(async (options) => {
        blocked.resolve()
        await release.promise
        await flush(options)
      })
      return workspace
    })
    const attempt = f.service.runNow(f.automation.id)
    await blocked.promise
    const run = f.store
      .listAutomationRuns(f.automation.id)
      .find((entry) => entry.status === 'dispatching')
    if (!run) {
      throw new Error('Missing claimed run')
    }
    f.store.updateAutomationRun({ runId: run.id, status: 'completed' })
    release.resolve()
    expect(await attempt).toMatchObject({ id: run.id, status: 'completed' })
    expect(f.dispatcher).not.toHaveBeenCalled()
    f.service.stop()
  })

  it.each(['stop', 'remove'] as const)(
    'cancels recovery when the automation is %s while creation is in flight',
    async (action) => {
      const f = await fixture()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      f.create.mockImplementation(async () => {
        started.resolve()
        await release.promise
        return { id: NEW_ID, displayName: 'Replacement' }
      })
      const attempt = f.service.runNow(f.automation.id)
      const rejected = expect(attempt).rejects.toThrow(
        action === 'stop' ? 'stopped before' : 'removed before'
      )
      await started.promise
      if (action === 'stop') {
        f.service.stop()
      } else {
        f.store.deleteAutomation(f.automation.id)
      }
      release.resolve()
      await rejected
      expect(f.dispatcher).not.toHaveBeenCalled()
      f.service.stop()
    }
  )

  it('keeps the path and host needed to recover a deleted folder workspace registration', async () => {
    const f = await fixture()
    const group = f.store.createProjectGroup({
      name: 'Folder project',
      parentPath: '/repo',
      createdFrom: 'folder-scan'
    })
    const folder = f.store.createFolderWorkspace({
      projectGroupId: group.id,
      folderPath: '/repo',
      name: 'Checks folder'
    })
    const pinned = f.store.updateAutomation(f.automation.id, { workspaceId: `folder:${folder.id}` })
    expect(pinned.workspaceRecovery).toEqual({
      kind: 'folder',
      projectGroupId: group.id,
      folderPath: '/repo',
      connectionId: null
    })
    f.store.removeFolderWorkspace(folder.id)
    expect(f.store.updateAutomation(f.automation.id, { enabled: false }).workspaceRecovery).toEqual(
      pinned.workspaceRecovery
    )
    f.service.stop()
  })

  it('keeps recovery inputs when the missing workspace automation is paused or renamed', async () => {
    const f = await fixture()
    const updated = f.store.updateAutomation(f.automation.id, { name: 'Renamed', enabled: false })
    expect(updated.workspaceRecovery).toEqual({ kind: 'worktree', baseBranch: 'origin/main' })
    f.service.stop()
  })

  it.each(['worktree', 'folder'] as const)(
    'captures recovery inputs for existing %s automations on upgrade',
    async (kind) => {
      const f = await fixture()
      f.store.setWorktreeMeta(OLD_ID, {
        displayName: 'Original',
        hostId: 'local',
        baseRef: 'origin/main'
      })
      if (kind === 'folder') {
        const group = f.store.createProjectGroup({
          name: 'Folder project',
          parentPath: '/repo',
          createdFrom: 'folder-scan'
        })
        const folder = f.store.createFolderWorkspace({
          projectGroupId: group.id,
          folderPath: '/repo',
          name: 'Checks folder'
        })
        f.store.updateAutomation(f.automation.id, { workspaceId: `folder:${folder.id}` })
      }
      const captured = f.store.listAutomations()[0].workspaceRecovery
      f.service.stop()
      await f.store.freezeWritesAsync()
      const file = join(testState.dir, 'orca-data.json')
      const persisted = JSON.parse(readPersistedStateJson(file))
      delete persisted.automations[0].workspaceRecovery
      writePersistedStateJson(file, JSON.stringify(persisted))
      const restored = await openStore()
      expect(restored.listAutomations()[0].workspaceRecovery).toEqual(captured)
    }
  )
})
