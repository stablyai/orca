import { describe, expect, it } from 'vitest'
import { savedTeamTabs, teamPaneIdentity } from './project-team-pane'
import { allocateTerminalPaneIdentity } from '../runtime/runtime-terminal-pane-identity'

const tabId = 'c180be61-886e-48b3-8c22-642d3553b099'
const leafId = 'afc85d49-fb91-4b95-ac68-9ea1f8440e12'
const tab = {
  ptyId: 'fixture-pty',
  worktreeId: 'workspace',
  id: tabId,
  title: 'PM',
  customTitle: 'PM',
  color: null,
  sortOrder: 0,
  createdAt: 1
}

describe('saved project team pane identity', () => {
  it('passes both persisted IDs through the real runtime allocator without minting a tab', () => {
    const [saved] = savedTeamTabs(
      {
        tabsByWorktree: { workspace: [tab] },
        terminalLayoutsByTabId: {
          [tabId]: { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
        }
      },
      'workspace'
    )
    const identity = teamPaneIdentity({ parentTabId: saved.id, leafId: saved.leafId })
    expect(allocateTerminalPaneIdentity(identity)).toMatchObject({ tabId, leafId })
  })
  it('blocks a saved tab without a layout instead of allocating a duplicate', () => {
    const [saved] = savedTeamTabs(
      { tabsByWorktree: { workspace: [tab] }, terminalLayoutsByTabId: {} },
      'workspace'
    )
    expect(() => teamPaneIdentity({ parentTabId: saved.id, leafId: saved.leafId })).toThrow(
      'team_saved_role_layout_required'
    )
  })
  it('uses a mounted leaf when the saved active leaf is stale', () => {
    const [saved] = savedTeamTabs(
      {
        tabsByWorktree: { workspace: [tab] },
        terminalLayoutsByTabId: {
          [tabId]: { root: { type: 'leaf', leafId }, activeLeafId: 'stale', expandedLeafId: null }
        }
      },
      'workspace'
    )
    expect(saved.leafId).toBe(leafId)
  })
})
