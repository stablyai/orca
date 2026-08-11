import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../shared/constants'
import { toSshExecutionHostId } from '../shared/execution-host'
import type { FolderWorkspace, ProjectGroup } from '../shared/types'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const targetId = 'conflicting-owner'
const executionHostId = toSshExecutionHostId(targetId)

function conflictingGroup(): ProjectGroup {
  return {
    id: 'conflicting-group',
    name: 'Conflicting group',
    parentPath: '/workspace/conflicting',
    connectionId: null,
    executionHostId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function conflictingWorkspace(): FolderWorkspace {
  return {
    id: 'conflicting-folder',
    projectGroupId: 'conflicting-group',
    name: 'Conflicting folder',
    folderPath: '/workspace/conflicting',
    connectionId: null,
    executionHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

async function createStore() {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      projectGroups: [conflictingGroup()],
      folderWorkspaces: [conflictingWorkspace()]
    }),
    'utf-8'
  )
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

describe('persistence folder owner conflicts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-folder-owner-conflict-'))
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps contradictory folder and group rows immutable', async () => {
    const store = await createStore()

    expect(store.getProjectGroups()).toHaveLength(1)
    expect(store.getFolderWorkspaces()).toHaveLength(1)
    expect(store.getFolderWorkspace('conflicting-folder')).toBeUndefined()
    expect(store.updateProjectGroup('conflicting-group', { name: 'Updated' })).toBeNull()
    expect(store.updateFolderWorkspace('conflicting-folder', { name: 'Updated' })).toBeNull()
    expect(store.deleteProjectGroup('conflicting-group')).toBe(false)
    expect(store.removeFolderWorkspace('conflicting-folder')).toBe(false)
    expect(store.getProjectGroups()).toEqual([
      expect.objectContaining({ name: 'Conflicting group' })
    ])
    expect(store.getFolderWorkspaces()).toEqual([
      expect.objectContaining({ name: 'Conflicting folder' })
    ])
  })
})
