import { describe, expect, it } from 'vitest'

import type { ProjectGroup } from '../shared/project-group-types'
import { formatNestedRepoImport, formatNestedRepoScan } from './project-group-format'

const group: ProjectGroup = {
  id: 'group-1',
  name: 'workspace',
  parentPath: '/workspace',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

describe('project-group CLI formatting', () => {
  it('formats nested scan candidates and completion state', () => {
    expect(
      formatNestedRepoScan({
        selectedPath: '/workspace',
        selectedPathKind: 'non_git_folder',
        repos: [
          { path: '/workspace/api', displayName: 'api', depth: 1 },
          { path: '/workspace/apps/web', displayName: 'web', depth: 2 }
        ],
        truncated: false,
        timedOut: false,
        stopped: false,
        durationMs: 42,
        maxDepth: 4,
        maxRepos: 100,
        timeoutMs: 15_000
      })
    ).toBe(
      [
        'root: /workspace',
        'kind: non_git_folder',
        'repositories: 2',
        'scan: 42ms  truncated:no  timedOut:no  stopped:no',
        'api  depth:1  /workspace/api',
        'web  depth:2  /workspace/apps/web'
      ].join('\n')
    )
  })

  it('formats group creation and per-project import outcomes', () => {
    expect(
      formatNestedRepoImport({
        group,
        projects: [
          { path: '/workspace/api', projectId: 'repo-1', status: 'imported' },
          { path: '/workspace/web', projectId: 'repo-2', status: 'already-known' },
          { path: '/workspace/broken', status: 'failed', error: 'Not a git repository' }
        ],
        importedCount: 1,
        alreadyKnownCount: 1,
        failedCount: 1
      })
    ).toBe(
      [
        'group: workspace (group-1)',
        'imported: 1',
        'alreadyKnown: 1',
        'failed: 1',
        'imported  repo-1  /workspace/api',
        'already-known  repo-2  /workspace/web',
        'failed  /workspace/broken  Not a git repository'
      ].join('\n')
    )
  })
})
