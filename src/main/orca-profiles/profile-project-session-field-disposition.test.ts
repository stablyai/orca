import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
  type PersistedClientHostedBrowserPage
} from '../../shared/workspace-session/client-hosted-browser-page-record'

import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { removeRepoFromWorkspaceSession } from './profile-project-session-state'
import { extractSessionForTransfer } from './profile-project-session-transfer'

const REMOVED_REPO_ID = 'repo-1'
const TRANSFER_TARGET_REPO_ID = 'repo-3'
const REMOVED_WORKTREE_ID = 'repo-1::/tmp/worktree-a'
const RETAINED_WORKTREE_ID = 'repo-2::/tmp/worktree-b'

function clientHostedRow(worktreeId: string): PersistedClientHostedBrowserPage {
  return {
    v: CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
    browserPageId: `page-${worktreeId}`,
    workspaceId: worktreeId,
    browserProfileId: 'profile-1',
    url: 'https://example.test/',
    title: 'Example',
    pairedDeviceId: 'device-1',
    savedAt: 1
  }
}

function sessionWithClientHostedRows(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeTabTypeByWorktree: {
      [REMOVED_WORKTREE_ID]: 'browser',
      [RETAINED_WORKTREE_ID]: 'browser'
    },
    clientHostedBrowserPagesByWorktree: {
      [REMOVED_WORKTREE_ID]: [clientHostedRow(REMOVED_WORKTREE_ID)],
      [RETAINED_WORKTREE_ID]: [clientHostedRow(RETAINED_WORKTREE_ID)]
    }
  }
}

describe('client-hosted rows in the repo-removal and transfer paths', () => {
  it('leaves client-hosted rows behind on transfer while a sibling map is rekeyed', () => {
    const result = extractSessionForTransfer(
      sessionWithClientHostedRows(),
      REMOVED_REPO_ID,
      TRANSFER_TARGET_REPO_ID
    )

    expect(result.activeTabTypeByWorktree).toEqual({ 'repo-3::/tmp/worktree-a': 'browser' })
    expect(result.clientHostedBrowserPagesByWorktree).toBeUndefined()
  })

  it('omits stale markdown visibility entries that no longer name an open file', () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        [REMOVED_WORKTREE_ID]: [
          {
            filePath: '/tmp/worktree-a/README.md',
            relativePath: 'README.md',
            worktreeId: REMOVED_WORKTREE_ID,
            language: 'markdown'
          }
        ]
      },
      markdownFrontmatterVisible: {
        '/tmp/worktree-a/README.md': false,
        '/tmp/worktree-a/closed.md': false
      }
    }

    const result = extractSessionForTransfer(session, REMOVED_REPO_ID, TRANSFER_TARGET_REPO_ID)

    expect(result.markdownFrontmatterVisible).toEqual({ '/tmp/worktree-a/README.md': false })
  })

  it('prunes markdown visibility for files in a removed repo', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        [REMOVED_WORKTREE_ID]: [
          {
            filePath: '/tmp/worktree-a/README.md',
            relativePath: 'README.md',
            worktreeId: REMOVED_WORKTREE_ID,
            language: 'markdown'
          }
        ],
        [RETAINED_WORKTREE_ID]: [
          {
            filePath: '/tmp/worktree-b/README.md',
            relativePath: 'README.md',
            worktreeId: RETAINED_WORKTREE_ID,
            language: 'markdown'
          }
        ]
      },
      markdownFrontmatterVisible: {
        '/tmp/worktree-a/README.md': false,
        '/tmp/worktree-b/README.md': false
      }
    }

    const result = removeRepoFromWorkspaceSession(session, REMOVED_REPO_ID)

    expect(result.markdownFrontmatterVisible).toEqual({ '/tmp/worktree-b/README.md': false })
  })

  it('keeps a unified-only terminal layout attached during transfer', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {},
      unifiedTabs: {
        [REMOVED_WORKTREE_ID]: [
          {
            id: 'terminal-tab-1',
            entityId: 'terminal-tab-1',
            groupId: 'group-1',
            worktreeId: REMOVED_WORKTREE_ID,
            contentType: 'terminal' as const,
            label: 'Terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'terminal-tab-1': {
          root: { type: 'leaf' as const, leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          titlesByLeafId: { 'leaf-1': 'shell' }
        }
      }
    }

    const result = extractSessionForTransfer(session, REMOVED_REPO_ID, TRANSFER_TARGET_REPO_ID)

    expect(result.terminalLayoutsByTabId).toEqual(session.terminalLayoutsByTabId)
  })
})
