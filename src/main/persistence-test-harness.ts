import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import type { Project, ProjectHostSetup } from '../shared/project-types'
import type { Repo } from '../shared/repo-types'
import type { TerminalTab } from '../shared/terminal-tab-types'
import type { WorkspaceLineage, WorktreeLineage } from '../shared/worktree/lineage-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import { Store } from './persistence/loading-store/store'
import { initDataPath } from './persistence/loading-store/user-data-path'

// Shared mutable state so the electron mock can reference a per-test directory
export const testState = { dir: '' }

/** Create a profile store without rebuilding its large module graph inside each test timeout. */
export function createStore(): Store {
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return new Store({ dataFile: dataFile() })
}

export async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  }
}

export function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

export function writeDataFile(data: unknown): void {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(dataFile(), JSON.stringify(data, null, 2), 'utf-8')
}

export function readDataFile(): unknown {
  return JSON.parse(readFileSync(dataFile(), 'utf-8'))
}

export function symlinkDirectorySync(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

export function collectPropertyPaths(value: unknown, property: string, prefix = ''): string[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  const paths: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (key === property) {
      paths.push(path)
    }
    paths.push(...collectPropertyPaths(child, property, path))
  }
  return paths
}

export const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

export const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#737373',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

export const makeProjectHostSetup = (
  overrides: Partial<ProjectHostSetup> = {}
): ProjectHostSetup => ({
  id: 'setup-1',
  projectId: 'project-1',
  hostId: 'local',
  repoId: '',
  path: '/repo',
  displayName: 'Project',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

export const makeTerminalTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 'tab1',
  ptyId: 'pty1',
  worktreeId: 'repo1::/worktree',
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  ...overrides
})

export const makeWorktreeLineage = (overrides: Partial<WorktreeLineage> = {}): WorktreeLineage => ({
  worktreeId: 'r1::/path/child',
  worktreeInstanceId: 'child-instance',
  parentWorktreeId: 'r1::/path/parent',
  parentWorktreeInstanceId: 'parent-instance',
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 1,
  ...overrides
})

export const makeWorkspaceLineage = (
  overrides: Partial<WorkspaceLineage> = {}
): WorkspaceLineage => ({
  childWorkspaceKey: worktreeWorkspaceKey('r1::/path/child'),
  childInstanceId: 'child-instance',
  parentWorkspaceKey: folderWorkspaceKey('folder-1'),
  parentInstanceId: null,
  origin: 'cli',
  capture: { source: 'env-workspace', confidence: 'inferred' },
  createdAt: 1,
  ...overrides
})
