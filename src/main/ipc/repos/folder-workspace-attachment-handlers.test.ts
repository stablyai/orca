import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../../persistence-test-harness'
import type { WorkspaceAttachment } from '../../../shared/worktree/types'
import { registerFolderWorkspaceHandlers } from './folder-workspace-handlers'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('./repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))

const linkedItems: WorkspaceAttachment[] = [
  { provider: 'github', type: 'pr', number: 7 },
  { provider: 'gitlab', type: 'mr', number: 8 },
  { provider: 'linear', type: 'issue', number: 0, identifier: 'APP-42' }
]

async function invoke(channel: string, args: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`Handler not registered: ${channel}`)
  }
  return handler(undefined, args)
}

describe('folder workspace attachment desktop IPC', () => {
  beforeEach(() => {
    handlers.clear()
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-folder-ipc-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('preserves all attachments through the registered update handler, durable reload, and list handler', async () => {
    const store = createStore()
    const group = store.createProjectGroup({
      name: 'Docs',
      parentPath: testState.dir,
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id })
    registerFolderWorkspaceHandlers(new BrowserWindow(), store, {
      deleteFolderWorkspace: vi.fn(async () => ({ deleted: true }))
    })
    expect(
      await invoke('folderWorkspaces:update', {
        folderWorkspaceId: workspace.id,
        updates: { linkedItems }
      })
    ).toMatchObject({ linkedItems })
    store.flush()
    const restored = createStore()
    expect(restored.getFolderWorkspace(workspace.id)?.linkedItems).toEqual(linkedItems)
    expect(await invoke('folderWorkspaces:list', undefined)).toContainEqual(
      expect.objectContaining({ linkedItems })
    )
    expect(
      await invoke('folderWorkspaces:update', {
        folderWorkspaceId: workspace.id,
        updates: { linkedItems: [] }
      })
    ).toMatchObject({ linkedItems: [], linkedTask: null })
  })

  it('preserves collections on creation and rejects malformed attachment writes', async () => {
    const store = createStore()
    const group = store.createProjectGroup({
      name: 'Docs',
      parentPath: testState.dir,
      createdFrom: 'folder-scan'
    })
    registerFolderWorkspaceHandlers(new BrowserWindow(), store, {
      deleteFolderWorkspace: vi.fn(async () => ({ deleted: true }))
    })
    expect(
      await invoke('folderWorkspaces:create', { projectGroupId: group.id, linkedItems })
    ).toMatchObject({ linkedItems })
    await expect(
      invoke('folderWorkspaces:create', { projectGroupId: group.id, linkedItems: [{}] })
    ).rejects.toThrow('invalid_folder_workspace_create_args')
  })
  it('preserves concurrent collection additions through desktop IPC', async () => {
    const store = createStore()
    const group = store.createProjectGroup({
      name: 'Docs',
      parentPath: testState.dir,
      createdFrom: 'folder-scan'
    })
    const base = [linkedItems[0]]
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, linkedItems: base })
    registerFolderWorkspaceHandlers(new BrowserWindow(), store, {
      deleteFolderWorkspace: vi.fn(async () => ({ deleted: true }))
    })
    await invoke('folderWorkspaces:update', {
      folderWorkspaceId: workspace.id,
      updates: { linkedItemsBase: base, linkedItems: [linkedItems[0], linkedItems[1]] }
    })
    await invoke('folderWorkspaces:update', {
      folderWorkspaceId: workspace.id,
      updates: { linkedItemsBase: base, linkedItems: [linkedItems[2]] }
    })
    expect(store.getFolderWorkspace(workspace.id)?.linkedItems).toEqual([
      linkedItems[1],
      linkedItems[2]
    ])
  })
})
