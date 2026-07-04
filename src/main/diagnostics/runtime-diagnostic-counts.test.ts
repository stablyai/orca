import { describe, expect, it } from 'vitest'
import {
  collectRuntimeDiagnosticCounts,
  type DiagnosticRuntimeStore
} from './runtime-diagnostic-counts'

describe('collectRuntimeDiagnosticCounts', () => {
  it('counts terminal panes inside nested split layouts', () => {
    const store = {
      getRepos: () => [{}, {}],
      getAllWorktreeMeta: () => ({
        one: { hostId: 'local' },
        two: { hostId: 'ssh' }
      }),
      getProjects: () => [],
      getProjectHostSetups: () => [],
      getFolderWorkspaces: () => [],
      getWorkspaceSession: () => ({
        tabsByWorktree: {
          one: [{ id: 'tab-1' }],
          two: [{ id: 'tab-2' }]
        },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: {
              type: 'split',
              first: { type: 'leaf', leafId: 'pane-1' },
              second: {
                type: 'split',
                first: { type: 'leaf', leafId: 'pane-2' },
                second: { type: 'leaf', leafId: 'pane-3' }
              }
            }
          },
          'tab-2': {
            root: { type: 'leaf', leafId: 'pane-4' }
          }
        }
      })
    } as unknown as DiagnosticRuntimeStore

    expect(collectRuntimeDiagnosticCounts(store)).toMatchObject({
      repoCount: 2,
      worktreeCount: 2,
      terminalTabCount: 2,
      terminalPaneCount: 4,
      runtimeHostCounts: {
        local: 1,
        ssh: 1
      }
    })
  })
})
