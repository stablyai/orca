import { EventEmitter } from 'node:events'
import { type Mock, vi } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

export type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

/** One loose mock type covers unrelated store methods. */
type StoreMock = Mock<(...args: unknown[]) => unknown>
type KeyedStoreMock = Mock<(id: string, ...rest: unknown[]) => unknown>
type KeyedStoreWriteMock = Mock<
  (target: HostWorktreeTarget, patch: Partial<WorktreeMeta>) => unknown
>
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
  getWorkspaceSessionHostIds: StoreMock
  getWorkspaceSession: StoreMock
  getAllWorktreeLineage: StoreMock
  removeWorktreeLineage: TargetStoreMock
  getAllWorkspaceLineage: StoreMock
  getFolderWorkspaces: StoreMock
  getProjectGroups: StoreMock
  addRetiredWorktreeName: StoreMock
  getRetiredWorktreeNameRegistry: StoreMock
  mergeRetiredWorktreeNames: StoreMock
}

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
  getWorkspaceSessionHostIds: vi.fn(),
  getWorkspaceSession: vi.fn(),
  getAllWorktreeLineage: vi.fn(),
  removeWorktreeLineage: vi.fn(),
  getAllWorkspaceLineage: vi.fn(),
  getFolderWorkspaces: vi.fn(),
  getProjectGroups: vi.fn(),
  addRetiredWorktreeName: vi.fn(),
  getRetiredWorktreeNameRegistry: vi.fn(),
  mergeRetiredWorktreeNames: vi.fn()
}
