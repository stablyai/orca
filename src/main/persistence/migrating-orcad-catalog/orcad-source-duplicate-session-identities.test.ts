import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectDuplicateOrcadMigrationSessionIdentities } from './orcad-source-duplicate-session-identities'

const WORKTREE = 'repo-1::/srv/repo'

function terminal(id: string, customTitle: string | null = null): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE,
    title: id,
    customTitle,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), tabsByWorktree: { [WORKTREE]: [] } }
}

describe('collectDuplicateOrcadMigrationSessionIdentities', () => {
  it('passes a session whose identities are unique', () => {
    const next = session()
    next.tabsByWorktree[WORKTREE] = [terminal('tab-a'), terminal('tab-b')]
    next.terminalLayoutsByTabId = {
      'tab-a': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        activeLeafId: 'leaf-a',
        expandedLeafId: null
      },
      'tab-b': {
        root: { type: 'leaf', leafId: 'leaf-b' },
        activeLeafId: 'leaf-b',
        expandedLeafId: null
      }
    }
    expect(collectDuplicateOrcadMigrationSessionIdentities(next)).toEqual([])
  })

  it('names a pane repeated inside one split by its tab title', () => {
    const next = session()
    next.tabsByWorktree[WORKTREE] = [terminal('tab-a', 'Build')]
    next.terminalLayoutsByTabId = {
      'tab-a': {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'leaf' },
          second: { type: 'leaf', leafId: 'leaf' }
        },
        activeLeafId: 'leaf',
        expandedLeafId: null
      }
    }
    expect(collectDuplicateOrcadMigrationSessionIdentities(next)).toEqual([
      'one terminal pane saved twice in the tab "Build" in /srv/repo: close that tab'
    ])
  })

  it('names a terminal tab id saved twice', () => {
    const next = session()
    next.tabsByWorktree[WORKTREE] = [terminal('tab-a'), terminal('tab-a')]
    expect(collectDuplicateOrcadMigrationSessionIdentities(next)).toEqual([
      'one terminal tab saved twice in /srv/repo: close one of them'
    ])
  })
})
