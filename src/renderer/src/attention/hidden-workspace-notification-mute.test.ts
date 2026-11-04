import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import { resolveAgentAttention } from '@/attention/agent-attention-policy'
import { createTerminalAttentionSurface } from '@/components/terminal-pane/terminal-attention-surface'
import { createStructuredAttentionSurface } from '@/components/native-chat/structured-attention-surface'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore, makeWorktree, TEST_REPO } from '../store/slices/store-test-helpers'
import { isWorkspaceNotificationMutedBySidebarFilters } from './hidden-workspace-notification-mute'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

const CLI_ID = 'repo1::/tmp/cli'
const PLAIN_ID = 'repo1::/tmp/plain'
const cliRow = makeWorktree({
  id: CLI_ID,
  repoId: 'repo1',
  path: '/tmp/cli',
  cliProvenance: { kind: 'created-by-cli', createdAt: 0 }
})
const plainRow = makeWorktree({ id: PLAIN_ID, repoId: 'repo1', path: '/tmp/plain' })

let store: ReturnType<typeof createTestStore>

function setNotifyHiddenWorkspaces(notifyHiddenWorkspaces: boolean): void {
  store.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      notifications: { ...getDefaultNotificationSettings(), notifyHiddenWorkspaces }
    }
  })
}

function muted(workspaceId: string): boolean {
  return isWorkspaceNotificationMutedBySidebarFilters(store.getState(), workspaceId)
}

beforeEach(() => {
  store = createTestStore()
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [cliRow, plainRow] },
    persistedUIReady: true,
    workspaceSessionReady: true,
    hideCliCreatedWorkspaces: true
  })
  setNotifyHiddenWorkspaces(false)
})

describe('isWorkspaceNotificationMutedBySidebarFilters', () => {
  it('mutes a workspace a Filters switch hides while the setting is off', () => {
    expect(muted(CLI_ID)).toBe(true)
    expect(muted(PLAIN_ID)).toBe(false)
  })

  it('mutes nothing when Notify about hidden workspaces is on', () => {
    setNotifyHiddenWorkspaces(true)
    expect(muted(CLI_ID)).toBe(false)
  })

  it('fails open before settings or UI state hydrate, and for an unknown workspace', () => {
    expect(muted('repo1::/tmp/unknown')).toBe(false)
    store.setState({ persistedUIReady: false })
    expect(muted(CLI_ID)).toBe(false)
    store.setState({ persistedUIReady: true, settings: null })
    expect(muted(CLI_ID)).toBe(false)
  })

  it('fails open until terminals reconnect, when Hide sleeping would read restored work as asleep', () => {
    store.setState({ hideCliCreatedWorkspaces: false, showSleepingWorkspaces: false })
    store.setState({ workspaceSessionReady: false })
    expect(muted(PLAIN_ID)).toBe(false)
    store.setState({ workspaceSessionReady: true })
    expect(muted(PLAIN_ID)).toBe(true)
  })

  it('keeps notifying for a hidden parent the sidebar shows above a visible child', () => {
    store.setState({
      worktreeLineageById: {
        [PLAIN_ID]: {
          worktreeId: PLAIN_ID,
          worktreeInstanceId: 'plain',
          parentWorktreeId: CLI_ID,
          parentWorktreeInstanceId: 'cli',
          origin: 'cli',
          capture: { source: 'terminal-context', confidence: 'inferred' },
          createdAt: 1
        }
      },
      worktreesByRepo: {
        repo1: [
          { ...cliRow, instanceId: 'cli' },
          { ...plainRow, instanceId: 'plain' }
        ]
      }
    })
    expect(muted(CLI_ID)).toBe(false)
  })

  it('keeps notifying for an id whose twin on another host the switches show', () => {
    store.setState({
      worktreesByRepo: {
        repo1: [cliRow, plainRow],
        'repo1@other-host': [{ ...cliRow, cliProvenance: undefined }]
      }
    })
    expect(muted(CLI_ID)).toBe(false)
  })

  it('mutes another client’s folder workspace under Hide other-client workspaces only', () => {
    const folder: FolderWorkspace = {
      id: 'f1',
      projectGroupId: 'g1',
      name: 'notes',
      folderPath: '/notes',
      creatorProvenance: { kind: 'paired-device', deviceId: 'phone' },
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    store.setState({ folderWorkspaces: [folder] })
    expect(muted(folderWorkspaceKey('f1'))).toBe(false)
    store.setState({ hideWorkspacesFromOtherDevices: true })
    expect(muted(folderWorkspaceKey('f1'))).toBe(true)
  })

  it('ignores the project filter, which is not a Filters switch', () => {
    store.setState({ hideCliCreatedWorkspaces: false, filterRepoIds: ['other-repo'] })
    expect(muted(PLAIN_ID)).toBe(false)
  })
})

describe('muted workspace attention', () => {
  it('earns no unread and no delivery request from the attention policy', () => {
    const decision = resolveAgentAttention(
      {
        subject: { workspaceId: CLI_ID, surfaceKey: 'tab-1:leaf-1' },
        reason: 'agent-completion',
        settlesTurn: true,
        hasFreshActivityEvidence: true
      },
      createTerminalAttentionSurface(store.getState())
    )
    expect(decision).toEqual({ admitted: false, cause: 'muted-workspace' })
    expect(createStructuredAttentionSurface(store.getState()).isWorkspaceMuted(CLI_ID)).toBe(true)
  })

  it('writes no bell marker for a muted workspace, and still does for a visible one', () => {
    const terminalTab = (id: string, worktreeId: string) => ({
      id,
      ptyId: null,
      worktreeId,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    })
    store.setState({
      tabsByWorktree: {
        [CLI_ID]: [terminalTab('tab-cli', CLI_ID)],
        [PLAIN_ID]: [terminalTab('tab-plain', PLAIN_ID)]
      }
    })
    store
      .getState()
      .markTerminalBell({ worktreeId: CLI_ID, tabId: 'tab-cli', paneKey: 'tab-cli:0' })
    store
      .getState()
      .markTerminalBell({ worktreeId: PLAIN_ID, tabId: 'tab-plain', paneKey: 'tab-plain:0' })
    const rows = store.getState().worktreesByRepo.repo1
    expect(rows.find((row) => row.id === CLI_ID)?.isUnread).toBe(false)
    expect(store.getState().unreadTerminalTabs['tab-cli']).toBeUndefined()
    expect(rows.find((row) => row.id === PLAIN_ID)?.isUnread).toBe(true)
    expect(store.getState().unreadTerminalTabs['tab-plain']).toBe('terminal-bell')
  })
})
