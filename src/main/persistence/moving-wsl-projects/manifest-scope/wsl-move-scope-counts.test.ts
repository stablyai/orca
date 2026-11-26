import { describe, expect, it } from 'vitest'
import { wslMoveScopeCounts } from './wsl-move-scope-counts'

const worktreeId = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\me\\app'

describe('wslMoveScopeCounts', () => {
  it('counts what the export carries: its workspaces, terminal panes and chats', () => {
    const exported = {
      workspaceIds: [worktreeId, 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\me\\app-2'],
      manifest: {
        payload: {
          dormantState: {
            workspaceSession: {
              tabsByWorktree: {},
              terminalLayoutsByTabId: {
                'term-1': {
                  root: {
                    type: 'split',
                    direction: 'vertical',
                    first: { type: 'leaf', leafId: 'a' },
                    second: { type: 'leaf', leafId: 'b' }
                  }
                }
              },
              unifiedTabs: {
                [worktreeId]: [
                  { id: 'u-1', entityId: 'term-1', contentType: 'terminal' },
                  { id: 'u-2', entityId: 'term-2', contentType: 'terminal' },
                  { id: 'u-3', entityId: 'chat-1', contentType: 'agent-session' },
                  { id: 'u-4', entityId: 'file', contentType: 'editor' }
                ]
              }
            }
          }
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the count reads only these fields.
    expect(wslMoveScopeCounts(exported as never)).toEqual({
      workspaces: 2,
      terminals: 3,
      chats: 1
    })
  })
})
