import { EventEmitter } from 'node:events'
import { type Mock, vi } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

export type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

/** Loose signature: one mock stands in for many unrelated store methods. */
type StoreMock = Mock<(...args: unknown[]) => unknown>
/** Store lookups tests re-implement per id, so the first arg stays narrowed. */
type KeyedStoreMock = Mock<(id: string, ...rest: unknown[]) => unknown>
/** Store writers tests re-implement by merging the patch they receive. */
type KeyedStoreWriteMock = Mock<
  (target: HostWorktreeTarget, patch: Partial<WorktreeMeta>) => unknown
>
/** Host-qualified store removals. */
type TargetStoreMock = Mock<(target: HostWorktreeTarget) => unknown>

export type TestMainWindow = {
  isDestroyed: () => boolean
  webContents: { send: Mock<(channel: string, ...args: unknown[]) => void> }
}

export type TestStore = {
  getProfileStorageDirectory: Mock<() => string>
  getRepos: StoreMock
  getRepo: KeyedStoreMock
  getProjects: StoreMock
  getSparsePresets: StoreMock
  getSettings: StoreMock
  getWorktreeMeta: KeyedStoreMock
  getWorktreeMetaForHost: StoreMock
  getAllWorktreeMeta: StoreMock
  captureNativeLocalWorktreeMetadataScanExpectation: StoreMock
  setWorktreeMeta: KeyedStoreWriteMock
  getProjectHostSetups: StoreMock
  removeWorktreeMeta: TargetStoreMock
  pruneSessionlessMissingLocalWorktreeMetadataForRepo: StoreMock
  removeWorkspaceSessionStateForWorktree: KeyedStoreMock
  getAllWorktreeLineage: StoreMock
  removeWorktreeLineage: TargetStoreMock
  getAllWorkspaceLineage: StoreMock
  getFolderWorkspaces: StoreMock
  getProjectGroups: StoreMock
  addRetiredWorktreeName: StoreMock
  getRetiredWorktreeNameRegistry: StoreMock
  mergeRetiredWorktreeNames: StoreMock
}

/** Channel handlers captured from the mocked ipcMain.handle during registration. */
export const handlers: HandlerMap = {}
export const mainWindow: TestMainWindow = {
  isDestroyed: () => false,
  webContents: {
    send: vi.fn()
  }
}
export const ipcEvent = { sender: Object.assign(new EventEmitter(), { id: 1 }) }
export const store: TestStore = {
  getProfileStorageDirectory: vi.fn(() => '/profile-a'),
  getRepos: vi.fn(),
  getRepo: vi.fn(),
  getProjects: vi.fn(),
  getSparsePresets: vi.fn(),
  getSettings: vi.fn(),
  getWorktreeMeta: vi.fn(),
  getWorktreeMetaForHost: vi.fn(),
  getAllWorktreeMeta: vi.fn(),
  captureNativeLocalWorktreeMetadataScanExpectation: vi.fn(),
  setWorktreeMeta: vi.fn(),
  getProjectHostSetups: vi.fn(),
  removeWorktreeMeta: vi.fn(),
  pruneSessionlessMissingLocalWorktreeMetadataForRepo: vi.fn(),
  removeWorkspaceSessionStateForWorktree: vi.fn(),
  getAllWorktreeLineage: vi.fn(),
  removeWorktreeLineage: vi.fn(),
  getAllWorkspaceLineage: vi.fn(),
  getFolderWorkspaces: vi.fn(),
  getProjectGroups: vi.fn(),
  addRetiredWorktreeName: vi.fn(),
  getRetiredWorktreeNameRegistry: vi.fn(),
  mergeRetiredWorktreeNames: vi.fn()
}
