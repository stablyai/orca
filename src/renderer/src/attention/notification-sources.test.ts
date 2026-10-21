import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { NotificationDispatchRequest } from '../../../shared/notification-settings-types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import {
  createTestStore,
  makeTabGroup,
  makeTab,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { dispatchTerminalNotification } from '@/components/terminal-pane/use-notification-dispatch'
import { dispatchStructuredTurnCompletionAttention } from '@/components/native-chat/structured-attention-dispatch'
import type { StructuredTab } from '@/components/native-chat/structured-agent-session-tabs'
import { buildNotificationSourceOptions } from './notification-sources'
import { resolveNotificationTabOwner } from './notification-subject-owner'

vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/lib/desktop-notification-sound', () => ({ playDesktopNotificationSound: vi.fn() }))
vi.mock('@/lib/blocked-notification-fallback', () => ({
  showBlockedNotificationFallbackToast: vi.fn()
}))

const store = createTestStore()
const paneKey = 'terminal:11111111-1111-4111-8111-111111111111'
const leafId = '11111111-1111-4111-8111-111111111111'
const sent: NotificationDispatchRequest[] = []

beforeEach(() => {
  sent.length = 0
  vi.stubGlobal('window', {
    api: {
      notifications: {
        dispatch: vi.fn(async (request: NotificationDispatchRequest) => {
          sent.push(request)
          return { delivered: true }
        })
      }
    }
  })
  vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
})
afterEach(() => vi.unstubAllGlobals())

function seed(
  hostId: ExecutionHostId,
  ptyId: string,
  folder: boolean,
  collision = false
): StructuredTab {
  const workspaceId = folder ? 'folder:folder-1' : 'repo1::/tmp/wt'
  const tab: StructuredTab = {
    ...makeUnifiedTab({
      id: 'chat',
      worktreeId: workspaceId,
      groupId: 'group',
      entityId: 'session',
      agentSessionAgent: 'claude',
      executionHostId: folder && ptyId.startsWith('remote:') ? 'runtime:hub' : hostId
    }),
    contentType: 'agent-session'
  }
  const folderRow: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: 'group',
    name: 'Folder',
    folderPath: '/tmp/folder',
    executionHostId: ptyId.startsWith('remote:') ? 'runtime:hub' : hostId,
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
  store.setState({
    settings: createGlobalSettingsFixture(),
    repos: [{ ...TEST_REPO, executionHostId: hostId }],
    worktreesByRepo: {
      repo1: [
        ...(collision ? [makeWorktree({ id: workspaceId, repoId: 'repo1', hostId: 'local' })] : []),
        makeWorktree({
          id: workspaceId,
          repoId: 'repo1',
          hostId,
          ...(ptyId.startsWith('remote:') ? { runtimeOwnerEnvironmentId: 'hub' } : {})
        })
      ]
    },
    folderWorkspaces: folder ? [folderRow] : [],
    projectGroups: [],
    activeWorktreeId: 'another-workspace',
    activeTabId: null,
    tabsByWorktree: {
      [workspaceId]: [makeTab({ id: 'terminal', worktreeId: workspaceId, ptyId })]
    },
    ptyIdsByTabId: { terminal: [ptyId] },
    terminalLayoutsByTabId: {
      terminal: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    },
    unifiedTabsByWorktree: { [workspaceId]: [tab] },
    groupsByWorktree: {
      [workspaceId]: [
        makeTabGroup({
          id: 'group',
          worktreeId: workspaceId,
          activeTabId: 'chat',
          tabOrder: ['chat']
        })
      ]
    },
    activeGroupIdByWorktree: { [workspaceId]: 'group' },
    agentStatusByPaneKey: {},
    suppressedPtyExitIds: {},
    unreadAgentCompletionPanes: {},
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    sshTargetLabels: new Map([['qa', 'QA']]),
    sshConnectionStates: new Map(),
    runtimeEnvironments: [
      {
        id: 'hub',
        name: 'Hub',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [],
        preferredEndpointId: 'endpoint'
      }
    ],
    runtimeStatusByEnvironmentId: new Map(),
    updateFolderWorkspace: async () => true
  })
  return tab
}

function dispatchChat(tab: StructuredTab): void {
  dispatchStructuredTurnCompletionAttention(tab, {
    sessionId: 'session',
    turnId: 'turn',
    outcome: 'success',
    completedAt: 100,
    scope: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'host-workspace',
      workspaceKind: 'git-worktree'
    }
  })
}

const ownershipCases = [
  { name: 'local', hostId: 'local', ptyId: 'repo1::/tmp/wt@@12345678', source: 'local' },
  { name: 'direct SSH', hostId: 'ssh:qa', ptyId: 'ssh:qa@@pty-1', source: 'ssh:qa' },
  {
    name: 'paired server',
    hostId: 'runtime:hub',
    ptyId: 'remote:hub@@pty-1',
    source: 'runtime:hub'
  },
  {
    name: 'paired server SSH target',
    hostId: 'ssh:qa',
    ptyId: 'remote:hub@@pty-1',
    source: 'runtime:hub'
  },
  {
    name: 'local recipe VM',
    hostId: 'ssh:runtime-ssh-vm-a',
    ptyId: 'ssh:runtime-ssh-vm-a@@pty-1',
    source: 'local'
  },
  {
    name: 'paired server recipe VM',
    hostId: 'ssh:runtime-ssh-vm-a',
    ptyId: 'remote:hub@@pty-1',
    source: 'runtime:hub'
  }
] satisfies { name: string; hostId: ExecutionHostId; ptyId: string; source: ExecutionHostId }[]

it.each(
  ownershipCases.flatMap((scenario) => [false, true].map((folder) => ({ ...scenario, folder })))
)(
  'both senders use the configured source for $name (folder=$folder)',
  ({ hostId, ptyId, source, folder }) => {
    sent.length = 0
    const tab = seed(hostId, ptyId, folder)
    dispatchTerminalNotification(tab.worktreeId, { source: 'terminal-bell', paneKey })
    dispatchChat(tab)
    expect(sent).toHaveLength(2)
    expect(sent.map((request) => request.notificationSourceId)).toEqual([source, source])
    const listed = buildNotificationSourceOptions(store.getState()).map((option) => option.id)
    expect(listed).toEqual(['local', 'runtime:hub', 'ssh:qa'])
    expect(listed).toContain(source)
  }
)

it.each([false, true])(
  'a local daemon PTY keeps local ownership when its SSH sibling is selected=%s',
  (selected) => {
    const tab = seed('ssh:qa', 'repo1::/tmp/wt@@12345678', false, true)
    store.setState({
      activeWorktreeId: selected ? tab.worktreeId : 'another-workspace',
      activeWorkspaceExecutionHostId: selected ? 'ssh:qa' : null
    })
    dispatchTerminalNotification(tab.worktreeId, { source: 'terminal-bell', paneKey })
    dispatchChat({ ...tab, executionHostId: 'local' })
    expect(sent.map((request) => request.notificationSourceId)).toEqual(['local', 'local'])
  }
)

it('keeps direct SSH independent from the same target name inside a paired server', () => {
  const tab = seed('ssh:qa', 'remote:hub@@pty-1', false)
  const state = store.getState()
  store.setState({
    worktreesByRepo: {
      repo1: [
        ...state.worktreesByRepo.repo1,
        makeWorktree({ id: tab.worktreeId, repoId: 'repo1', hostId: 'ssh:qa' })
      ]
    }
  })
  dispatchTerminalNotification(tab.worktreeId, { source: 'terminal-bell', paneKey })
  dispatchChat({ ...tab, executionHostId: 'runtime:hub' })
  expect(sent.map((request) => request.notificationSourceId)).toEqual([
    'runtime:hub',
    'runtime:hub'
  ])
  expect(resolveNotificationTabOwner(store.getState(), tab)).toBeNull()
})

it('uses the captured transport owner while catalogs and bindings hydrate', () => {
  const tab = seed('ssh:qa', 'ssh:qa@@pty-1', false)
  store.setState({
    worktreesByRepo: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {}
  })
  dispatchTerminalNotification(tab.worktreeId, {
    source: 'agent-task-complete',
    paneKey,
    agentStatusSnapshot: { state: 'done', agentType: 'codex', stateStartedAt: 1, prompt: 'done' },
    workspaceOwner: { executionHostId: 'local', runtimeEnvironmentId: null }
  })
  expect(sent[0]?.notificationSourceId).toBe('local')
})

it('does not invent an owner for an opaque remote PTY', () => {
  const tab = seed('local', 'remote:unqualified', false)
  dispatchTerminalNotification(tab.worktreeId, { source: 'terminal-bell', paneKey })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.notificationSourceId).toBeUndefined()
})

it('does not list removed SSH targets or recipe VMs from leftover workspace records', () => {
  seed('ssh:qa', 'ssh:qa@@pty-1', false)
  store.setState({
    sshTargetLabels: new Map(),
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {}
  })
  expect(buildNotificationSourceOptions(store.getState()).map((option) => option.id)).toEqual([
    'local',
    'runtime:hub'
  ])
  seed('ssh:runtime-ssh-vm-a', 'ssh:runtime-ssh-vm-a@@pty-1', false)
  expect(buildNotificationSourceOptions(store.getState()).map((option) => option.id)).toEqual([
    'local',
    'runtime:hub',
    'ssh:qa'
  ])
})

it('folds an automatically paired recipe VM into this computer', () => {
  const tab = seed('runtime:hub', 'remote:hub@@pty-1', false)
  store.setState({
    runtimeEnvironments: store
      .getState()
      .runtimeEnvironments.map((environment) => ({ ...environment, source: 'ephemeral-vm' }))
  })
  dispatchTerminalNotification(tab.worktreeId, { source: 'terminal-bell', paneKey })
  dispatchChat(tab)
  expect(sent.map((request) => request.notificationSourceId)).toEqual(['local', 'local'])
  expect(buildNotificationSourceOptions(store.getState()).map((option) => option.id)).toEqual([
    'local',
    'ssh:qa'
  ])
})

it('omits a removed source even when its live binding and catalog record remain', () => {
  const tab = seed('ssh:qa', 'ssh:qa@@pty-1', false)
  store.setState({ sshTargetLabels: new Map() })
  dispatchTerminalNotification(tab.worktreeId, { source: 'terminal-bell', paneKey })
  dispatchChat(tab)
  expect(sent).toHaveLength(2)
  expect(sent.map((request) => request.notificationSourceId)).toEqual([undefined, undefined])
})
