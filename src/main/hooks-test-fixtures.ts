import type { Repo } from '../shared/repo-types'

import { join } from 'node:path'

export const TEST_REPO_PATH = join('/test/repo')
export const TEST_WORKTREE_PATH = join('/test/worktree')
export const TEST_REPO_ORCA_YAML_PATH = join(TEST_REPO_PATH, 'orca.yaml')
export const TEST_WORKTREE_ORCA_YAML_PATH = join(TEST_WORKTREE_PATH, 'orca.yaml')
export const TEST_ISSUE_COMMAND_PATH = join(TEST_REPO_PATH, '.orca', 'issue-command')
export const TEST_GITIGNORE_PATH = join(TEST_REPO_PATH, '.gitignore')

/** Minimal repo record the hooks module reads; hookSettings shape varies per suite. */
export const makeHookTestRepo = (hookSettings?: unknown): Repo =>
  ({
    id: 'test-id',
    path: '/test/repo',
    displayName: 'Test Repo',
    badgeColor: '#000',
    addedAt: Date.now(),
    hookSettings
  }) as unknown as Repo
