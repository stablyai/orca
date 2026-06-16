/* eslint-disable max-lines -- Why: runtime behavior is stateful and cross-cutting, so these tests stay in one file to preserve the end-to-end invariants around handles, waits, and graph sync. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ipcMain } from 'electron'
import type {
  FolderWorkspace,
  ProjectGroup,
  TerminalLayoutSnapshot,
  WorktreeLineage,
  WorktreeMeta,
  WorkspaceLineage,
  WorkspaceSessionState
} from '../../shared/types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import {
  addWorktree,
  assertWorktreeCleanForRemoval,
  listWorktrees,
  removeWorktree
} from '../git/worktree'
import * as gitRunner from '../git/runner'
import {
  createSetupRunnerScript,
  getEffectiveHooks,
  getEffectiveHooksFromConfig,
  hasHooksFile,
  loadHooks,
  parseOrcaYaml,
  runHook,
  shouldRunSetupForCreate
} from '../hooks'
import { getBranchConflictKind, getDefaultBaseRef } from '../git/repo'
import type { OrchestrationDb } from './orchestration/db'
import type { MessagePriority, MessageRow, MessageType } from './orchestration/types'
import {
  appendNormalizedToTailBuffer,
  appendRecentPtyOutput,
  buildPreview,
  OrcaRuntimeService,
  type RuntimeTerminalAgentStatusEvent
} from './orca-runtime'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { DEFAULT_REPO_BADGE_COLOR, getDefaultWorkspaceSession } from '../../shared/constants'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import { makePaneKey } from '../../shared/stable-pane-id'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcRequest } from './rpc/core'
import { TERMINAL_METHODS } from './rpc/methods/terminal'

const electronMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()
  const ipcMain = {
    on: vi.fn((channel: string, listener: Listener) => {
      const existing = listeners.get(channel) ?? new Set<Listener>()
      existing.add(listener)
      listeners.set(channel, existing)
      return ipcMain
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener)
      return ipcMain
    }),
    emit: vi.fn((channel: string, ...args: unknown[]) => {
      for (const listener of listeners.get(channel) ?? []) {
        listener(...args)
      }
      return true
    })
  }
  return {
    BrowserWindow: { fromId: vi.fn((_id: number): unknown => null) },
    webContents: { fromId: vi.fn((_id: number): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp') }
  }
})

vi.mock('electron', () => electronMocks)

const {
  MOCK_GIT_WORKTREES,
  addWorktreeMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  sshGitProviders,
  getSshGitProviderMock,
  registerSshGitProviderMock,
  unregisterSshGitProviderMock,
  getActiveMultiplexerMock,
  muxRequestMock,
  invalidateAuthorizedRootsCacheMock,
  prepareLocalWorktreeRootForRepoMock,
  createHostedReviewMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  getPRForBranchMock,
  listGitHubIssuesMock,
  detectInstalledAgentsMock,
  detectRemoteAgentsMock,
  listGitLabMergeRequestsMock,
  listGitLabWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabTodosMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  createGitLabIssueMock,
  updateGitLabIssueMock,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  resolveGitLabMRDiscussionMock,
  getGitLabJobTraceMock,
  retryGitLabJobMock,
  mergeGitLabMRMock,
  closeGitLabMRMock,
  reopenGitLabMRMock,
  getGlabKnownHostsMock,
  getGitLabWorkItemDetailsMock,
  updateGitLabMRReviewersMock,
  getIssueMock,
  deleteWorktreeHistoryDirMock
} = vi.hoisted(() => {
  // Why: SSH runtime tests register providers through the public dispatcher API,
  // so the mock needs the same registry semantics as the real module.
  const sshGitProviders = new Map<string, unknown>()

  return {
    MOCK_GIT_WORKTREES: [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ],
    addWorktreeMock: vi.fn(),
    removeWorktreeMock: vi.fn(),
    forceDeleteLocalBranchMock: vi.fn(),
    computeWorktreePathMock: vi.fn(),
    ensurePathWithinWorkspaceMock: vi.fn(),
    sshGitProviders,
    getSshGitProviderMock: vi.fn((connectionId: string) => sshGitProviders.get(connectionId)),
    registerSshGitProviderMock: vi.fn((connectionId: string, provider: unknown) => {
      sshGitProviders.set(connectionId, provider)
    }),
    unregisterSshGitProviderMock: vi.fn((connectionId: string) => {
      sshGitProviders.delete(connectionId)
    }),
    getActiveMultiplexerMock: vi.fn(),
    muxRequestMock: vi.fn(),
    invalidateAuthorizedRootsCacheMock: vi.fn(),
    prepareLocalWorktreeRootForRepoMock: vi.fn(),
    createHostedReviewMock: vi.fn(),
    getHostedReviewCreationEligibilityMock: vi.fn(),
    getHostedReviewForBranchMock: vi.fn(),
    getPRForBranchMock: vi.fn().mockResolvedValue(null),
    listGitHubIssuesMock: vi.fn(),
    detectInstalledAgentsMock: vi.fn(),
    detectRemoteAgentsMock: vi.fn(),
    listGitLabMergeRequestsMock: vi.fn(),
    listGitLabWorkItemsMock: vi.fn(),
    listGitLabIssuesMock: vi.fn(),
    listGitLabLabelsMock: vi.fn(),
    listGitLabTodosMock: vi.fn(),
    getGitLabProjectRefForRemoteMock: vi.fn(),
    getGitLabWorkItemByProjectRefMock: vi.fn(),
    createGitLabIssueMock: vi.fn(),
    updateGitLabIssueMock: vi.fn(),
    addGitLabIssueCommentMock: vi.fn(),
    addGitLabMRCommentMock: vi.fn(),
    addGitLabMRInlineCommentMock: vi.fn(),
    resolveGitLabMRDiscussionMock: vi.fn(),
    getGitLabJobTraceMock: vi.fn(),
    retryGitLabJobMock: vi.fn(),
    mergeGitLabMRMock: vi.fn(),
    closeGitLabMRMock: vi.fn(),
    reopenGitLabMRMock: vi.fn(),
    getGlabKnownHostsMock: vi.fn(),
    getGitLabWorkItemDetailsMock: vi.fn(),
    updateGitLabMRReviewersMock: vi.fn(),
    getIssueMock: vi.fn(),
    deleteWorktreeHistoryDirMock: vi.fn()
  }
})

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  assertWorktreeCleanForRemoval: vi.fn().mockResolvedValue(undefined),
  addWorktree: addWorktreeMock,
  removeWorktree: removeWorktreeMock,
  forceDeleteLocalBranch: forceDeleteLocalBranchMock
}))

vi.mock('../terminal-history', () => ({
  deleteWorktreeHistoryDir: deleteWorktreeHistoryDirMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.',
  requireSshGitProvider: (connectionId: string) => {
    const provider = getSshGitProviderMock(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    return provider
  },
  registerSshGitProvider: registerSshGitProviderMock,
  unregisterSshGitProvider: unregisterSshGitProviderMock
}))

vi.mock('../ipc/ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock
}))

vi.mock('../ipc/preflight', () => ({
  detectInstalledAgents: detectInstalledAgentsMock,
  detectRemoteAgents: detectRemoteAgentsMock
}))

vi.mock('../hooks', () => ({
  buildPosixRunnerScript: (script: string) => `#!/usr/bin/env bash\nset -e\n${script}\n`,
  buildWindowsRunnerScript: (script: string) => `@echo off\r\n${script}\r\n`,
  createSetupRunnerScript: vi.fn(),
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  getEffectiveHooksFromConfig: vi.fn().mockReturnValue(null),
  getDefaultTabCommandTrustContent: vi.fn(
    (hooks: { scripts?: { setup?: string } } | null) => hooks?.scripts?.setup?.trim() ?? ''
  ),
  getDefaultTabsLaunch: vi.fn().mockReturnValue(undefined),
  getSetupRunnerEnvVars: (_repo: never, worktreePath: string) => ({
    ORCA_ROOT_PATH: '/remote/repo',
    ORCA_WORKTREE_PATH: worktreePath
  }),
  loadHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' }),
  shouldRunSetupForCreate: vi
    .fn()
    .mockImplementation((_repo: never, decision: string) => decision === 'run'),
  getEffectiveSetupRunPolicy: vi.fn().mockReturnValue('auto'),
  hasHooksFile: vi.fn().mockReturnValue(false),
  parseOrcaYaml: vi.fn().mockReturnValue(null)
}))

vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    computeWorktreePath: computeWorktreePathMock,
    ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock
  }
})

vi.mock('../ipc/filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock,
  isENOENT: (error: unknown) =>
    Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: prepareLocalWorktreeRootForRepoMock
}))

vi.mock('../source-control/hosted-review-creation', () => ({
  createHostedReview: createHostedReviewMock,
  getHostedReviewCreationEligibility: getHostedReviewCreationEligibilityMock
}))

vi.mock('../source-control/hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))

vi.mock('../github/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getPRForBranch: getPRForBranchMock,
    listIssues: listGitHubIssuesMock
  }
})

vi.mock('../gitlab/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listMergeRequests: listGitLabMergeRequestsMock,
    listWorkItems: listGitLabWorkItemsMock,
    listIssues: listGitLabIssuesMock,
    listLabels: listGitLabLabelsMock,
    listTodos: listGitLabTodosMock,
    getProjectRefForRemote: getGitLabProjectRefForRemoteMock,
    getWorkItemByProjectRef: getGitLabWorkItemByProjectRefMock,
    createIssue: createGitLabIssueMock,
    updateIssue: updateGitLabIssueMock,
    addIssueComment: addGitLabIssueCommentMock,
    addMRComment: addGitLabMRCommentMock,
    addMRInlineComment: addGitLabMRInlineCommentMock,
    resolveMRDiscussion: resolveGitLabMRDiscussionMock,
    getJobTrace: getGitLabJobTraceMock,
    retryJob: retryGitLabJobMock,
    mergeMR: mergeGitLabMRMock,
    closeMR: closeGitLabMRMock,
    reopenMR: reopenGitLabMRMock,
    updateMRReviewers: updateGitLabMRReviewersMock
  }
})

vi.mock('../gitlab/gl-utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getGlabKnownHosts: getGlabKnownHostsMock
  }
})

vi.mock('../gitlab/work-item-details', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getWorkItemDetails: getGitLabWorkItemDetailsMock
  }
})

vi.mock('../github/issues', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getIssue: getIssueMock
  }
})

// Why: the CLI create-worktree path calls getDefaultBaseRef to resolve a
// fallback base branch. Real resolution shells out to `git` against the
// test's fabricated repo path, which has no refs, so we stub it to a
// predictable 'origin/main'. The runtime no longer silently fabricates this
// default, so tests that want the legacy behavior must express it via the mock.
vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: vi.fn().mockResolvedValue(null),
    getGitUsername: vi.fn().mockReturnValue('')
  }
})

afterEach(() => {
  advertisedUrlWatcher.clear()
  electronMocks.BrowserWindow.fromId.mockReset()
  electronMocks.BrowserWindow.fromId.mockReturnValue(null)
  electronMocks.webContents.fromId.mockReset()
  electronMocks.webContents.fromId.mockReturnValue(null)
  electronMocks.ipcMain.on.mockClear()
  electronMocks.ipcMain.removeListener.mockClear()
  electronMocks.ipcMain.emit.mockClear()
  vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(addWorktree).mockReset()
  vi.mocked(assertWorktreeCleanForRemoval).mockReset()
  vi.mocked(assertWorktreeCleanForRemoval).mockResolvedValue(undefined)
  vi.mocked(removeWorktree).mockReset()
  vi.mocked(forceDeleteLocalBranchMock).mockReset()
  vi.mocked(forceDeleteLocalBranchMock).mockResolvedValue(undefined)
  sshGitProviders.clear()
  getSshGitProviderMock.mockReset()
  getSshGitProviderMock.mockImplementation((connectionId: string) =>
    sshGitProviders.get(connectionId)
  )
  registerSshGitProviderMock.mockReset()
  registerSshGitProviderMock.mockImplementation((connectionId: string, provider: unknown) => {
    sshGitProviders.set(connectionId, provider)
  })
  unregisterSshGitProviderMock.mockReset()
  unregisterSshGitProviderMock.mockImplementation((connectionId: string) => {
    sshGitProviders.delete(connectionId)
  })
  muxRequestMock.mockReset()
  muxRequestMock.mockResolvedValue(undefined)
  getActiveMultiplexerMock.mockReset()
  getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
  vi.mocked(createSetupRunnerScript).mockReset()
  vi.mocked(getEffectiveHooks).mockReset()
  vi.mocked(getEffectiveHooksFromConfig).mockReset()
  vi.mocked(loadHooks).mockReset()
  vi.mocked(hasHooksFile).mockReset()
  vi.mocked(parseOrcaYaml).mockReset()
  vi.mocked(runHook).mockReset()
  vi.mocked(shouldRunSetupForCreate).mockReset()
  vi.mocked(shouldRunSetupForCreate).mockImplementation((_repo, decision) => decision === 'run')
  vi.mocked(getEffectiveHooks).mockReturnValue(null)
  vi.mocked(getEffectiveHooksFromConfig).mockReturnValue(null)
  vi.mocked(loadHooks).mockReturnValue(null)
  vi.mocked(hasHooksFile).mockReturnValue(false)
  vi.mocked(parseOrcaYaml).mockReturnValue(null)
  computeWorktreePathMock.mockReset()
  ensurePathWithinWorkspaceMock.mockReset()
  invalidateAuthorizedRootsCacheMock.mockReset()
  prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
  createHostedReviewMock.mockReset()
  createHostedReviewMock.mockResolvedValue({
    ok: true,
    provider: 'github',
    number: 1,
    url: 'https://example.com/pull/1'
  })
  getHostedReviewCreationEligibilityMock.mockReset()
  getHostedReviewCreationEligibilityMock.mockResolvedValue({
    provider: 'github',
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
    defaultBaseRef: 'main',
    head: 'feature/foo',
    title: null,
    body: null
  })
  getHostedReviewForBranchMock.mockReset()
  getHostedReviewForBranchMock.mockResolvedValue(null)
  getPRForBranchMock.mockReset()
  getPRForBranchMock.mockResolvedValue(null)
  listGitHubIssuesMock.mockReset()
  listGitHubIssuesMock.mockResolvedValue({ items: [] })
  detectInstalledAgentsMock.mockReset()
  detectInstalledAgentsMock.mockResolvedValue([])
  detectRemoteAgentsMock.mockReset()
  detectRemoteAgentsMock.mockResolvedValue([])
  listGitLabMergeRequestsMock.mockReset()
  listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
  listGitLabWorkItemsMock.mockReset()
  listGitLabWorkItemsMock.mockResolvedValue({ items: [] })
  listGitLabIssuesMock.mockReset()
  listGitLabIssuesMock.mockResolvedValue({ items: [] })
  listGitLabLabelsMock.mockReset()
  listGitLabLabelsMock.mockResolvedValue(['bug'])
  listGitLabTodosMock.mockReset()
  listGitLabTodosMock.mockResolvedValue([])
  getGitLabProjectRefForRemoteMock.mockReset()
  getGitLabProjectRefForRemoteMock.mockResolvedValue({ host: 'gitlab.example', path: 'group/repo' })
  getGlabKnownHostsMock.mockReset()
  getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
  getGitLabWorkItemByProjectRefMock.mockReset()
  getGitLabWorkItemByProjectRefMock.mockResolvedValue(null)
  createGitLabIssueMock.mockReset()
  createGitLabIssueMock.mockResolvedValue({
    ok: true,
    number: 1,
    url: 'https://gitlab.example/i/1'
  })
  updateGitLabIssueMock.mockReset()
  updateGitLabIssueMock.mockResolvedValue({ ok: true })
  addGitLabIssueCommentMock.mockReset()
  addGitLabIssueCommentMock.mockResolvedValue({ ok: true })
  addGitLabMRCommentMock.mockReset()
  addGitLabMRCommentMock.mockResolvedValue({ ok: true })
  addGitLabMRInlineCommentMock.mockReset()
  addGitLabMRInlineCommentMock.mockResolvedValue({ ok: true })
  resolveGitLabMRDiscussionMock.mockReset()
  resolveGitLabMRDiscussionMock.mockResolvedValue({ ok: true })
  getGitLabJobTraceMock.mockReset()
  getGitLabJobTraceMock.mockResolvedValue({ ok: true, trace: 'log' })
  retryGitLabJobMock.mockReset()
  retryGitLabJobMock.mockResolvedValue({ ok: true })
  mergeGitLabMRMock.mockReset()
  mergeGitLabMRMock.mockResolvedValue({ ok: true })
  closeGitLabMRMock.mockReset()
  closeGitLabMRMock.mockResolvedValue({ ok: true })
  reopenGitLabMRMock.mockReset()
  reopenGitLabMRMock.mockResolvedValue({ ok: true })
  getGitLabWorkItemDetailsMock.mockReset()
  getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
  updateGitLabMRReviewersMock.mockReset()
  updateGitLabMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })
  getIssueMock.mockReset()
  getIssueMock.mockResolvedValue(null)
})

function syncSinglePty(
  runtime: OrcaRuntimeService,
  ptyId: string | null = 'pty-1',
  options: { tabTitle?: string | null; paneTitle?: string | null } = {}
): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        title: options.tabTitle ?? 'Codex',
        activeLeafId: 'pane:1',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        leafId: 'pane:1',
        paneRuntimeId: 1,
        ptyId,
        paneTitle: options.paneTitle ?? null
      }
    ]
  })
}

const TEST_WINDOW_ID = 1
const TEST_REPO_ID = 'repo-1'
const TEST_REPO_PATH = '/tmp/repo'
const TEST_WORKTREE_PATH = '/tmp/worktree-a'
const TEST_WORKTREE_ID = `${TEST_REPO_ID}::${TEST_WORKTREE_PATH}`
const TEST_FOLDER_PROJECT_GROUP_ID = 'folder-project-group-1'
const TEST_FOLDER_WORKSPACE_ID = 'folder-workspace-1'
const TEST_FOLDER_WORKSPACE_KEY = `folder:${TEST_FOLDER_WORKSPACE_ID}`
const TEST_FOLDER_WORKSPACE_PATH = '/tmp/platform'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEADLESS_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HEADLESS_SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

function antigravityReadyScreen(model = 'Gemini 3.5 Flash (High)'): string {
  return [
    'Antigravity CLI 1.0.3',
    'user@example.com (Antigravity Business)',
    model,
    '~/orca/workspaces/orca/agy-dispatch-issue',
    '>'
  ].join('\n')
}

function antigravityPromptBeforeModelReadyScreen(model = 'Gemini 3.5 Flash (High)'): string {
  return [
    'Antigravity CLI 1.0.3',
    'user@example.com',
    '~/orca/workspaces/orca/agy-dispatch-issue',
    '',
    '',
    '',
    '',
    '>',
    '',
    '? for shortcuts',
    `\t\t  ${model}`,
    '~/orca/workspaces/orca/agy-dispatch-issue',
    '',
    model,
    ' (Antigravity Business)'
  ].join('\n')
}

// Why: these runtime feature tests only need message-queue semantics; using
// SQLite here makes them fail on unrelated native runtime ABI drift.
class InMemoryOrchestrationMessages {
  private sequence = 0

  private messages: MessageRow[] = []

  insertMessage(msg: {
    from: string
    to: string
    subject: string
    body?: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    payload?: string
  }): MessageRow {
    this.sequence += 1
    const row: MessageRow = {
      id: `msg_${this.sequence}`,
      from_handle: msg.from,
      to_handle: msg.to,
      subject: msg.subject,
      body: msg.body ?? '',
      type: msg.type ?? 'status',
      priority: msg.priority ?? 'normal',
      thread_id: msg.threadId ?? null,
      payload: msg.payload ?? null,
      read: 0,
      sequence: this.sequence,
      created_at: '1970-01-01 00:00:00',
      delivered_at: null
    }
    this.messages.push(row)
    return row
  }

  getUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    return this.messages
      .filter(
        (message) =>
          message.to_handle === toHandle &&
          message.read === 0 &&
          (!types || types.length === 0 || types.includes(message.type))
      )
      .sort((a, b) => a.sequence - b.sequence)
  }

  getUndeliveredUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    return this.getUnreadMessages(toHandle, types).filter((message) => !message.delivered_at)
  }

  markAsDelivered(ids: string[]): void {
    const deliveredIds = new Set(ids)
    for (const message of this.messages) {
      if (deliveredIds.has(message.id)) {
        message.delivered_at = '1970-01-01 00:00:00'
      }
    }
  }

  close(): void {}
}

function setInMemoryOrchestrationMessages(
  runtime: OrcaRuntimeService,
  db: InMemoryOrchestrationMessages
): void {
  runtime.setOrchestrationDb(db as unknown as OrchestrationDb)
}

function expectStablePaneKeyEnv(env: Record<string, string>): string {
  expect(env.ORCA_TAB_ID).toMatch(UUID_RE)
  const leafId = env.ORCA_PANE_KEY?.slice(`${env.ORCA_TAB_ID}:`.length)
  expect(leafId).toMatch(UUID_RE)
  expect(env.ORCA_PANE_KEY).toBe(`${env.ORCA_TAB_ID}:${leafId}`)
  return env.ORCA_PANE_KEY
}

function createRuntime(): OrcaRuntimeService {
  return new OrcaRuntimeService(store)
}

function makeFolderProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: TEST_FOLDER_PROJECT_GROUP_ID,
    name: 'Platform',
    parentPath: TEST_FOLDER_WORKSPACE_PATH,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    ...overrides,
    id: overrides.id ?? TEST_FOLDER_WORKSPACE_ID,
    projectGroupId: overrides.projectGroupId ?? TEST_FOLDER_PROJECT_GROUP_ID,
    name: overrides.name ?? 'Refund fix',
    folderPath: overrides.folderPath ?? TEST_FOLDER_WORKSPACE_PATH,
    linkedTask: overrides.linkedTask ?? null,
    comment: overrides.comment ?? '',
    isArchived: overrides.isArchived ?? false,
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    sortOrder: overrides.sortOrder ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 1,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1
  }
}

function createFolderWorkspaceRuntimeStore(
  folderWorkspace: FolderWorkspace = makeFolderWorkspace(),
  projectGroup: ProjectGroup = makeFolderProjectGroup()
) {
  return {
    ...store,
    getProjectGroups: () => [projectGroup],
    getFolderWorkspaces: () => [folderWorkspace]
  }
}

function makeRpcRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeWorktreeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createStaleRuntimeWorktreeStore(
  worktreeId: string,
  metaOverrides: Partial<WorktreeMeta> = {}
) {
  const metaById: Record<string, WorktreeMeta> = {
    [worktreeId]: makeWorktreeMeta(metaOverrides)
  }
  const removeWorktreeMeta = vi.fn((id: string) => {
    delete metaById[id]
  })
  const runtimeStore = {
    ...store,
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Partial<WorktreeMeta>) => {
      metaById[id] = { ...(metaById[id] ?? makeWorktreeMeta()), ...meta }
      return metaById[id]
    },
    removeWorktreeMeta
  }
  return { runtimeStore, removeWorktreeMeta }
}

const store = {
  getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
  getRepos: () => [
    {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    }
  ],
  addRepo: () => {},
  updateRepo: (id: string, updates: Record<string, unknown>) =>
    ({
      ...store.getRepo(id),
      ...updates
    }) as never,
  getAllWorktreeMeta: () => ({
    [TEST_WORKTREE_ID]: {
      displayName: 'foo',
      comment: '',
      linkedIssue: 123,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }),
  getWorktreeMeta: (worktreeId: string) => store.getAllWorktreeMeta()[worktreeId],
  setWorktreeMeta: (_worktreeId: string, meta: Record<string, unknown>) =>
    ({
      ...store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
      ...meta
    }) as never,
  removeWorktreeMeta: () => {},
  getSparsePresets: () => [],
  saveSparsePreset: (preset: unknown) => preset as never,
  getGitHubCache: () => undefined as never,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

function makeHeadlessTerminalLayout(
  ptyIdsByLeafId: Record<string, string | undefined>
): TerminalLayoutSnapshot {
  const leafIds = Object.keys(ptyIdsByLeafId)
  const firstLeafId = leafIds[0] ?? HEADLESS_LEAF_ID
  return {
    root:
      leafIds.length > 1
        ? {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: leafIds[0]! },
            second: { type: 'leaf', leafId: leafIds[1]! }
          }
        : { type: 'leaf', leafId: firstLeafId },
    activeLeafId: firstLeafId,
    expandedLeafId: null,
    ptyIdsByLeafId: Object.fromEntries(
      Object.entries(ptyIdsByLeafId).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  }
}

function makeRuntimeStoreWithWorkspaceSession(initialSession: WorkspaceSessionState): {
  runtimeStore: typeof store & {
    getWorkspaceSession: () => WorkspaceSessionState
    setWorkspaceSession: ReturnType<typeof vi.fn>
    persistPtyBinding: ReturnType<typeof vi.fn>
  }
  getSession: () => WorkspaceSessionState
} {
  let session = initialSession
  const runtimeStore = {
    ...store,
    getWorkspaceSession: () => session,
    setWorkspaceSession: vi.fn((next: WorkspaceSessionState) => {
      session = next
    }),
    persistPtyBinding: vi.fn(
      (args: { worktreeId: string; tabId: string; leafId: string; ptyId: string }) => {
        const tabs = session.tabsByWorktree[args.worktreeId] ?? []
        session = {
          ...session,
          tabsByWorktree: {
            ...session.tabsByWorktree,
            [args.worktreeId]: tabs.map((tab) =>
              tab.id === args.tabId ? { ...tab, ptyId: args.ptyId } : tab
            )
          },
          terminalLayoutsByTabId: {
            ...session.terminalLayoutsByTabId,
            [args.tabId]: {
              ...(session.terminalLayoutsByTabId[args.tabId] ?? {
                root: { type: 'leaf', leafId: args.leafId },
                activeLeafId: args.leafId,
                expandedLeafId: null
              }),
              ptyIdsByLeafId: {
                ...session.terminalLayoutsByTabId[args.tabId]?.ptyIdsByLeafId,
                [args.leafId]: args.ptyId
              }
            }
          }
        }
      }
    )
  }
  return { runtimeStore, getSession: () => session }
}

function makeWorkspaceSessionWithHeadlessTerminal(
  overrides: Partial<WorkspaceSessionState> = {}
): WorkspaceSessionState {
  const layout = makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty' })
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: TEST_REPO_ID,
    activeWorktreeId: TEST_WORKTREE_ID,
    activeTabId: 'host-tab',
    activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'host-tab' },
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'host-tab',
          ptyId: 'persisted-pty',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Persisted Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: { 'host-tab': layout },
    ...overrides
  }
}

computeWorktreePathMock.mockImplementation(
  (
    sanitizedName: string,
    repoPath: string,
    settings: { nestWorkspaces: boolean; workspaceDir: string }
  ) => {
    if (settings.nestWorkspaces) {
      const repoName =
        repoPath
          .split(/[\\/]/)
          .at(-1)
          ?.replace(/\.git$/, '') ?? 'repo'
      return `${settings.workspaceDir}/${repoName}/${sanitizedName}`
    }
    return `${settings.workspaceDir}/${sanitizedName}`
  }
)
ensurePathWithinWorkspaceMock.mockImplementation((targetPath: string) => targetPath)

describe('OrcaRuntimeService', () => {
  it('rejects relative paths for runtime nested repo scan/import', async () => {
    const runtime = new OrcaRuntimeService({
      ...store,
      createProjectGroup: vi.fn(),
      moveProjectToGroup: vi.fn()
    } as never)

    await expect(runtime.scanNestedRepos('relative/project')).rejects.toThrow(
      'Project path must be an absolute path'
    )
    await expect(
      runtime.importNestedRepos({
        parentPath: 'relative/project',
        groupName: 'Project',
        projectPaths: ['relative/project/api'],
        mode: 'group'
      })
    ).rejects.toThrow('Project path must be an absolute path')
  })

  it('starts unavailable with no authoritative window', () => {
    const runtime = createRuntime()

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'unavailable',
      authoritativeWindowId: null,
      rendererGraphEpoch: 0
    })
    expect(runtime.getRuntimeId()).toBeTruthy()
  })

  it('reports runtime protocol, capabilities, and mobile aliases on status', () => {
    const runtime = createRuntime()

    const status = runtime.getStatus()
    expect(typeof status.runtimeProtocolVersion).toBe('number')
    expect(typeof status.minCompatibleRuntimeClientVersion).toBe('number')
    expect(status.runtimeProtocolVersion).toBe(status.protocolVersion)
    expect(status.minCompatibleRuntimeClientVersion).toBe(status.minCompatibleMobileVersion)
    expect(status.capabilities).toContain('terminal.binary-stream.v1')
    expect(status.capabilities).toContain('workspace-ports.v1')
    expect(status.capabilities).toContain('mobile.tasks.v1')
    expect(status.capabilities).toContain('project-host-setup.v1')
    expect(status.capabilities).not.toContain('browser.screencast.v1')
    expect(typeof status.protocolVersion).toBe('number')
    expect(typeof status.minCompatibleMobileVersion).toBe('number')
    expect(status.protocolVersion).toBeGreaterThanOrEqual(1)
    expect(status.minCompatibleMobileVersion).toBeGreaterThanOrEqual(0)
  })

  it('advertises browser screencast only when a renderer window is available', () => {
    const runtime = createRuntime()
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)

    runtime.attachWindow(TEST_WINDOW_ID)

    expect(runtime.getStatus().capabilities).toContain('browser.screencast.v1')
  })

  it('claims the first window as authoritative and ignores later windows', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.attachWindow(2)

    expect(runtime.getStatus().authoritativeWindowId).toBe(TEST_WINDOW_ID)
  })

  it('bumps the epoch and enters reloading when the authoritative window reloads', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'reloading',
      rendererGraphEpoch: 1
    })
  })

  it('can mark the graph ready for the authoritative window', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    expect(runtime.getStatus().graphStatus).toBe('ready')
  })

  it('drops back to unavailable and clears authority when the window disappears', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)
    runtime.markGraphUnavailable(TEST_WINDOW_ID)

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'unavailable',
      authoritativeWindowId: null,
      rendererGraphEpoch: 2
    })
  })

  it('stays unavailable during initial loads before a graph is published', () => {
    const runtime = createRuntime()

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markRendererReloading(TEST_WINDOW_ID)

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'unavailable',
      rendererGraphEpoch: 0
    })
  })

  it('lists live terminals and issues stable handles for synced leaves', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'hello from terminal\n', 123)

    const terminals = await runtime.listTerminals('branch:feature/foo')
    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      worktreeId: 'repo-1::/tmp/worktree-a',
      branch: 'feature/foo',
      title: 'Claude',
      preview: 'hello from terminal'
    })

    const shown = await runtime.showTerminal(terminals.terminals[0].handle)
    expect(shown.handle).toBe(terminals.terminals[0].handle)
    expect(shown.ptyId).toBe('pty-1')
  })

  it('routes PTY output through the PTY leaf index in large terminal graphs', () => {
    const runtime = new OrcaRuntimeService(store)
    const liveLeafCount = 2773
    const targetIndex = liveLeafCount - 17
    const tabs = Array.from({ length: liveLeafCount }, (_, index) => ({
      tabId: `tab-${index}`,
      worktreeId: `repo-1::/tmp/worktree-${index}`,
      title: `Terminal ${index}`,
      activeLeafId: 'pane:1',
      layout: null
    }))
    const leaves = Array.from({ length: liveLeafCount }, (_, index) => ({
      tabId: `tab-${index}`,
      worktreeId: `repo-1::/tmp/worktree-${index}`,
      leafId: 'pane:1',
      paneRuntimeId: 1,
      ptyId: `pty-${index}`
    }))

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs, leaves })

    const runtimePrivate = runtime as unknown as {
      leaves: Map<string, unknown>
      leavesByPtyId: Map<string, { preview?: string; lastOutputAt?: number | null }[]>
    }
    const originalLeaves = runtimePrivate.leaves
    runtimePrivate.leaves = new Proxy(originalLeaves, {
      get(target, prop) {
        if (
          prop === 'values' ||
          prop === 'entries' ||
          prop === 'keys' ||
          prop === Symbol.iterator
        ) {
          return () => {
            throw new Error('onPtyData should use the PTY leaf index')
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as Map<string, unknown>

    runtime.onPtyData(`pty-${targetIndex}`, 'hello indexed\n', 123)

    const [targetLeaf] = runtimePrivate.leavesByPtyId.get(`pty-${targetIndex}`) ?? []
    expect(targetLeaf).toMatchObject({
      preview: 'hello indexed',
      lastOutputAt: 123
    })
    expect(runtime.getStatus().liveLeafCount).toBe(liveLeafCount)
  })

  it('resolves branch selectors when worktrees store refs/heads-prefixed branches', async () => {
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'refs/heads/Jinwoo-H/test-3a',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const runtime = new OrcaRuntimeService(store)

    const worktree = await runtime.showManagedWorktree('branch:Jinwoo-H/test-3a')
    expect(worktree).toMatchObject({
      branch: 'refs/heads/Jinwoo-H/test-3a',
      path: '/tmp/worktree-a'
    })
  })

  it('routes SSH-backed forward-slash UNC file and git paths without collapsing the root', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(new Error('local git should not run for SSH repos'))
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '//Server/Share/Repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '//Server/Share/Repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      })
    }
    const fsProvider = { readDir: vi.fn().mockResolvedValue([]) }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '//Server/Share/Repo',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      getStatus: vi.fn().mockResolvedValue({
        branch: 'feature/foo',
        files: [],
        ahead: 0,
        behind: 0,
        hasConflicts: false
      })
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await runtime.readFileExplorerDir('path://server/share/repo', 'src')
      await runtime.getRuntimeGitStatus('path://server/share/repo')
      await expect(runtime.showRepo('path://server/share/repo')).resolves.toMatchObject({
        path: '//Server/Share/Repo'
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(gitProvider.listWorktrees).toHaveBeenCalledWith('//Server/Share/Repo')
    expect(fsProvider.readDir).toHaveBeenCalledWith('\\\\Server\\Share\\Repo\\src')
    expect(gitProvider.getStatus).toHaveBeenCalledWith('//Server/Share/Repo')
  })

  it('lists persisted SSH worktrees while the git provider is unavailable', async () => {
    vi.mocked(listWorktrees).mockClear()
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-missing'
    }
    const mainId = `${remoteRepo.id}::/home/user/repo`
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const metaById: Record<string, WorktreeMeta> = {
      [mainId]: makeWorktreeMeta({ displayName: 'Remote main' }),
      [childId]: makeWorktreeMeta({ displayName: 'Remote child', linkedPR: 42 })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: () => remoteRepo,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const listed = await runtime.listManagedWorktrees('id:remote-repo')

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).toHaveBeenCalledWith('ssh-missing')
    expect(listed).toMatchObject({
      totalCount: 2,
      truncated: false,
      worktrees: [
        {
          id: mainId,
          path: '/home/user/repo',
          branch: '',
          isMainWorktree: true,
          displayName: 'Remote main'
        },
        {
          id: childId,
          path: '/home/user/repo-child',
          branch: '',
          isMainWorktree: false,
          displayName: 'Remote child',
          linkedPR: 42
        }
      ]
    })
  })

  it('does not interpret active as a runtime-global worktree selector', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.showManagedWorktree('active')).rejects.toThrow('selector_not_found')
  })

  it('does not reuse stale in-flight worktree scans after creating a worktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    const staleScan = deferred<typeof MOCK_GIT_WORKTREES>()
    const createdWorktree = {
      path: '/tmp/workspaces/cache-race',
      head: 'def',
      branch: 'cache-race',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees)
      .mockImplementationOnce(() => staleScan.promise)
      .mockResolvedValueOnce([createdWorktree])
      .mockResolvedValueOnce([...MOCK_GIT_WORKTREES, createdWorktree])

    const staleLookup = runtime.showManagedWorktree(TEST_WORKTREE_ID)
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'cache-race'
    })
    const freshLookup = runtime.showManagedWorktree(result.worktree.id)

    staleScan.resolve(MOCK_GIT_WORKTREES)

    await expect(staleLookup).resolves.toMatchObject({ id: TEST_WORKTREE_ID })
    await expect(freshLookup).resolves.toMatchObject({
      id: result.worktree.id,
      path: createdWorktree.path
    })
  })

  it('creates additional workspace metadata for folder-mode repos through runtime create', async () => {
    const folderRepo = {
      id: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'Folder',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'folder' as const
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getRepos: () => [folderRepo],
      getRepo: (id: string) => (id === folderRepo.id ? folderRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeMeta: (worktreeId: string) => {
        delete metaById[worktreeId]
      }
    }
    let deletedWorktreeId = ''
    const localProvider = {
      listProcesses: vi.fn(async () => [{ id: `${deletedWorktreeId}@@pty-1` }]),
      shutdown: vi.fn(async () => undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:folder-repo',
      name: 'folder-session',
      createdWithAgent: 'codex'
    })

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(result.worktree).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^folder-repo::\/workspace\/folder::workspace:[0-9a-f-]{36}$/),
        repoId: 'folder-repo',
        path: '/workspace/folder',
        displayName: 'folder-session',
        isMainWorktree: false,
        createdWithAgent: 'codex'
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({
      instanceId: result.worktree.instanceId,
      displayName: 'folder-session',
      orcaCreationSource: 'runtime',
      createdWithAgent: 'codex'
    })
    await expect(runtime.showManagedWorktree(`id:${result.worktree.id}`)).resolves.toMatchObject({
      id: result.worktree.id,
      repoId: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'folder-session'
    })
    await expect(runtime.listManagedWorktrees('id:folder-repo')).resolves.toMatchObject({
      totalCount: 2,
      worktrees: [
        expect.objectContaining({
          id: 'folder-repo::/workspace/folder',
          isMainWorktree: true
        }),
        expect.objectContaining({
          id: result.worktree.id,
          isMainWorktree: false
        })
      ]
    })
    await expect(
      runtime.updateManagedWorktreeMeta(`id:${result.worktree.id}`, { comment: 'note' })
    ).resolves.toMatchObject({
      id: result.worktree.id,
      comment: 'note'
    })
    await expect(
      runtime.removeManagedWorktree('id:folder-repo::/workspace/folder')
    ).rejects.toThrow('Cannot delete the project root workspace')
    deletedWorktreeId = result.worktree.id
    await expect(runtime.removeManagedWorktree(`id:${result.worktree.id}`)).resolves.toEqual({})
    expect(localProvider.shutdown).toHaveBeenCalledWith(`${result.worktree.id}@@pty-1`, {
      immediate: true
    })
    expect(metaById[result.worktree.id]).toBeUndefined()
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(result.worktree.id)
    expect(notifier.worktreesChanged).toHaveBeenCalledWith('folder-repo')
  })

  it('refreshes runtime remote-tracking bases before creating local worktrees', async () => {
    const runtime = new OrcaRuntimeService(store)
    const refresh = deferred<{ stdout: string; stderr: string }>()
    const createdWorktree = {
      path: '/tmp/workspaces/cli-fresh-base',
      head: 'def',
      branch: 'cli-fresh-base',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/cli-fresh-base^{commit}')) {
        throw new Error('branch not found')
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      if (args[0] === 'fetch') {
        return refresh.promise
      }
      return { stdout: '', stderr: '' }
    })
    try {
      const createPromise = runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'cli-fresh-base'
      })

      await vi.waitFor(() => {
        expect(gitSpy).toHaveBeenCalledWith(
          ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
          { cwd: TEST_REPO_PATH }
        )
      })
      expect(addWorktree).not.toHaveBeenCalled()

      refresh.resolve({ stdout: '', stderr: '' })
      const result = await createPromise

      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'cli-fresh-base',
        'origin/main',
        false,
        false,
        {
          suggestLocalBaseRefUpdate: true,
          remoteTrackingBase: {
            remote: 'origin',
            branch: 'main',
            ref: 'refs/remotes/origin/main',
            base: 'origin/main'
          }
        }
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        baseRef: 'refs/remotes/origin/main'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('returns runtime local base update suggestions from addWorktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/cli-stale-main',
      head: 'def',
      branch: 'cli-stale-main',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockResolvedValueOnce({
      localBaseRefUpdateSuggestion: {
        baseRef: 'origin/main',
        localBranch: 'main',
        behind: 5
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/cli-stale-main^{commit}')) {
        throw new Error('branch not found')
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'cli-stale-main'
      })

      expect(result.localBaseRefUpdateSuggestion).toEqual({
        baseRef: 'origin/main',
        localBranch: 'main',
        behind: 5
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('does not create runtime local worktrees when remote-tracking base refresh fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: '/tmp/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'base-sha\n', stderr: '' }
      }
      if (args[0] === 'fetch') {
        throw new Error('network unavailable')
      }
      return { stdout: '', stderr: '' }
    })
    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'cli-refresh-fails'
        })
      ).rejects.toThrow(
        'Could not refresh base ref "origin/main" from "origin". Check your network and try again.'
      )

      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates a branchNameOverride worktree from the selected matching remote base ref', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({ stdout: '', stderr: '' })
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/feature-something')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/feature-something')
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/feature-something',
        head: 'def',
        branch: 'feature/something',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'feature/something',
      baseBranch: 'origin/feature/something',
      branchNameOverride: 'feature/something'
    })

    expect(getBranchConflictKind).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/something',
      'origin/feature/something'
    )
    expect(addWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      '/tmp/workspaces/feature-something',
      'feature/something',
      'origin/feature/something',
      false
    )
    expect(result.worktree).toMatchObject({
      path: '/tmp/workspaces/feature-something',
      branch: 'feature/something'
    })
  })

  it('checks out a selected existing local branch even when that branch already has a PR', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-bug-0',
      head: 'def',
      branch: 'refs/heads/fix/bug-0',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockClear()
    getPRForBranchMock.mockResolvedValue({
      number: 42,
      title: 'Existing PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'branch-sha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix/bug-0',
        baseBranch: 'fix/bug-0',
        branchNameOverride: 'fix/bug-0'
      })

      expect(getBranchConflictKind).not.toHaveBeenCalled()
      expect(getPRForBranchMock).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'fix/bug-0',
        'fix/bug-0',
        false,
        false,
        { checkoutExistingBranch: true }
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/fix/bug-0'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates a same-repo PR branch override from a resolved head SHA and matching push target', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title',
      head: 'abc123',
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getPRForBranchMock.mockResolvedValueOnce({
      number: 42,
      title: 'Selected PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix',
        linkedPR: 42,
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })

      expect(getBranchConflictKind).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix', 'abc123')
      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        'abc123',
        false
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['branch', '--set-upstream-to', 'origin/feature/fix', 'feature/fix'],
        { cwd: createdWorktree.path }
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/feature/fix'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates a selected Bitbucket PR branch override from a matching remote branch', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/bitbucket-title',
      head: 'abc123',
      branch: 'refs/heads/feature/bitbucket',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    getHostedReviewForBranchMock.mockResolvedValueOnce({
      provider: 'bitbucket',
      number: 11,
      title: 'Bitbucket PR',
      state: 'open',
      url: 'https://bitbucket.org/team/repo/pull-requests/11',
      status: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'bitbucket-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/bitbucket',
        linkedBitbucketPR: 11,
        pushTarget: { remoteName: 'origin', branchName: 'feature/bitbucket' }
      })

      expect(getBranchConflictKind).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        'feature/bitbucket',
        'abc123'
      )
      expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: TEST_REPO_PATH,
          branch: 'feature/bitbucket',
          linkedBitbucketPR: 11
        })
      )
      expect(getPRForBranchMock).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/bitbucket',
        'abc123',
        false
      )
      expect(result.worktree).toMatchObject({
        path: createdWorktree.path,
        branch: 'refs/heads/feature/bitbucket',
        linkedBitbucketPR: 11
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('rejects an existing PR when a matching push target lacks selected PR metadata', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/fix-title')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/fix-title')
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce(null)
    getPRForBranchMock.mockResolvedValueOnce({
      number: 42,
      title: 'Existing PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'fix-title',
          baseBranch: 'abc123',
          branchNameOverride: 'feature/fix',
          pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
        })
      ).rejects.toThrow('Branch "feature/fix" already has PR #42.')

      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('rejects a matching push target branch when selected PR metadata has no PR number', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/fix-title')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/fix-title')
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'fix-title',
          baseBranch: 'abc123',
          branchNameOverride: 'feature/fix',
          linkedPR: null,
          pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
        })
      ).rejects.toThrow('Branch "feature/fix" already exists on a remote.')

      expect(getPRForBranchMock).not.toHaveBeenCalled()
      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('rejects a matching push target branch when the existing PR is different', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/fix-title')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/fix-title')
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    getPRForBranchMock.mockResolvedValueOnce({
      number: 43,
      title: 'Different PR',
      state: 'open',
      url: 'https://example.com/pr/43',
      checksStatus: 'success',
      updatedAt: '2026-05-21T00:00:00Z',
      mergeable: 'UNKNOWN'
    })
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'fix-title',
          baseBranch: 'abc123',
          branchNameOverride: 'feature/fix',
          linkedPR: 42,
          pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
        })
      ).rejects.toThrow('Branch "feature/fix" already has PR #43.')

      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('rejects a selected PR remote conflict when the PR lookup fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/fix-title')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/fix-title')
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce('remote')
    getPRForBranchMock.mockRejectedValueOnce(new Error('gh unavailable'))
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'fix-title',
          baseBranch: 'abc123',
          branchNameOverride: 'feature/fix',
          linkedPR: 42,
          pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
        })
      ).rejects.toThrow('Could not verify selected PR branch "feature/fix". Try again.')

      expect(getPRForBranchMock).toHaveBeenCalledWith(TEST_REPO_PATH, 'feature/fix')
      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('checks out an unused runtime PR branch only when it is at the resolved head SHA', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title',
      head: 'abc123',
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(getBranchConflictKind).mockClear()
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix'
      })

      expect(getBranchConflictKind).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        'abc123',
        false,
        false,
        { checkoutExistingBranch: true }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('suffixes only the runtime worktree path when an exact PR branch checkout path exists', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/fix-title-2',
      head: 'abc123',
      branch: 'refs/heads/feature/fix',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockImplementation((sanitizedName: string) =>
      sanitizedName === 'fix-title' ? process.cwd() : `/tmp/workspaces/${sanitizedName}`
    )
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockClear()
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: TEST_REPO_PATH,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('abc123^{commit}')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'fix-title',
        baseBranch: 'abc123',
        branchNameOverride: 'feature/fix'
      })

      expect(getBranchConflictKind).not.toHaveBeenCalled()
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'feature/fix',
        'abc123',
        false,
        false,
        { checkoutExistingBranch: true }
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('rejects when every exact PR branch checkout path suffix is occupied', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue(process.cwd())
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce(null)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'fix-title',
          baseBranch: 'abc123',
          branchNameOverride: 'feature/fix'
        })
      ).rejects.toThrow(
        'Could not find an available worktree path for "fix-title". Pick a different worktree name.'
      )

      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates SSH-backed worktrees through the SSH provider for mobile/runtime callers', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/mobile-feature',
      head: 'def',
      branch: 'refs/heads/mobile-feature',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'mobile-feature',
      linkedGitLabIssue: 321,
      linkedGitLabMR: 654,
      startup: { command: 'claude' }
    })

    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'mobile-feature',
      '/remote/mobile-feature',
      { base: 'origin/main' }
    )
    expect(result.worktree).toMatchObject({
      id: `${TEST_REPO_ID}::${created.path}`,
      path: created.path,
      linkedGitLabIssue: 321,
      linkedGitLabMR: 654
    })
    expect(metaById[result.worktree.id]).toMatchObject({
      linkedGitLabIssue: 321,
      linkedGitLabMR: 654
    })
    expect(addWorktree).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('records lineage for SSH-backed CLI-created worktrees', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const parent = {
      path: '/remote/repo-parent',
      head: 'abc',
      branch: 'refs/heads/repo-parent',
      isBare: false,
      isMainWorktree: false
    }
    const created = {
      path: '/remote/child-feature',
      head: 'def',
      branch: 'refs/heads/child-feature',
      isBare: false,
      isMainWorktree: false
    }
    const parentId = `${TEST_REPO_ID}::${parent.path}`
    const childId = `${TEST_REPO_ID}::${created.path}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId],
      setWorktreeLineage: vi.fn((worktreeId: string, lineage: WorktreeLineage) => {
        lineageById[worktreeId] = lineage
        return lineage
      })
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValueOnce([parent]).mockResolvedValue([parent, created])
    }
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'child-feature',
        lineage: { parentWorktree: `id:${parentId}` }
      })

      expect(result.worktree).toMatchObject({
        id: childId,
        parentWorktreeId: parentId,
        lineage: expect.objectContaining({
          worktreeId: childId,
          parentWorktreeId: parentId,
          worktreeInstanceId: metaById[childId].instanceId,
          parentWorktreeInstanceId: 'parent-instance',
          origin: 'cli'
        })
      })
      expect(result.lineage).toBe(result.worktree.lineage)
      expect(result.warnings).toEqual([])
      expect(remoteStore.setWorktreeLineage).toHaveBeenCalledWith(childId, expect.any(Object))
      expect(addWorktree).not.toHaveBeenCalled()
      expect(listWorktrees).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('records folder workspace lineage inferred from environment context', async () => {
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/tmp/workspaces/folder-child',
      head: 'def',
      branch: 'refs/heads/folder-child',
      isBare: false,
      isMainWorktree: false
    }
    const childId = `${TEST_REPO_ID}::${created.path}`
    const metaById: Record<string, WorktreeMeta> = {}
    const workspaceLineageByChildKey: Record<string, WorkspaceLineage> = {}
    const runtimeStore = {
      ...createFolderWorkspaceRuntimeStore(),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      setWorkspaceLineage: vi.fn((lineage: WorkspaceLineage) => {
        workspaceLineageByChildKey[lineage.childWorkspaceKey] = lineage
        return lineage
      })
    }
    computeWorktreePathMock.mockReturnValue(created.path)
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(listWorktrees).mockResolvedValueOnce([created])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'folder-child',
      baseBranch: 'origin/main',
      lineage: { envParentWorkspace: TEST_FOLDER_WORKSPACE_KEY }
    })

    expect(addWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      created.path,
      'folder-child',
      'origin/main',
      false
    )
    expect(result.lineage).toBeNull()
    expect(result.workspaceLineage).toMatchObject({
      childWorkspaceKey: `worktree:${childId}`,
      childInstanceId: metaById[childId].instanceId,
      parentWorkspaceKey: TEST_FOLDER_WORKSPACE_KEY,
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'env-workspace', confidence: 'inferred' }
    })
    expect(result.worktree.workspaceLineage).toBe(result.workspaceLineage)
    expect(runtimeStore.setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        childWorkspaceKey: `worktree:${childId}`,
        parentWorkspaceKey: TEST_FOLDER_WORKSPACE_KEY
      })
    )
  })

  it('activates SSH worktrees created with startup agents', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/agent-feature',
      head: 'def',
      branch: 'refs/heads/agent-feature',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-agent-startup' })
    const activateWorktree = vi.fn()
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-remote-agent-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'agent-feature',
        startupAgent: 'codex',
        startupPrompt: 'hi',
        activate: true
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/agent-feature',
          command: "codex '--dangerously-bypass-approvals-and-sandbox' 'hi'",
          worktreeId: result.worktree.id
        })
      )
      expect(activateWorktree).toHaveBeenCalledWith(
        TEST_REPO_ID,
        result.worktree.id,
        undefined,
        undefined,
        undefined
      )
      expect(addWorktree).not.toHaveBeenCalled()
      expect(listWorktrees).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('quotes startup prompts for Windows SSH worktrees using PowerShell syntax', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: 'C:/remote/agent-feature',
      head: 'def',
      branch: 'refs/heads/agent-feature',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: 'C:/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-windows-agent' })
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-remote-windows-agent' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    try {
      await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'agent-feature',
        startupAgent: 'codex',
        startupPrompt: "fix Bob's branch"
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: 'C:/remote/agent-feature',
          command: "codex '--dangerously-bypass-approvals-and-sandbox' 'fix Bob''s branch'"
        })
      )
      expect(addWorktree).not.toHaveBeenCalled()
      expect(listWorktrees).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('launches SSH setup terminals for runtime task-created worktrees', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/mobile-setup',
      head: 'def',
      branch: 'refs/heads/mobile-setup',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse') {
          return {
            stdout: '/remote/repo/.git/worktrees/mobile-setup/orca/setup-runner.sh\n',
            stderr: ''
          }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({ isBinary: false, content: 'hooks:\n' }),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    vi.mocked(getEffectiveHooksFromConfig).mockReturnValue({
      scripts: { setup: 'pnpm worktree:setup' }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-remote-agent' })
      .mockResolvedValueOnce({ id: 'pty-remote-setup' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-remote' })
    registerSshGitProvider('ssh-1', provider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-setup',
        setupDecision: 'run',
        startup: { command: 'claude' }
      })

      expect(result.setup).toMatchObject({
        runnerScriptPath: '/remote/repo/.git/worktrees/mobile-setup/orca/setup-runner.sh'
      })
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          cwd: '/remote/mobile-setup',
          command: 'claude',
          worktreeId: result.worktree.id
        })
      )
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          cwd: '/remote/mobile-setup',
          command: 'bash /remote/repo/.git/worktrees/mobile-setup/orca/setup-runner.sh',
          worktreeId: result.worktree.id
        })
      )
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-remote-setup',
          title: 'Setup',
          activate: false
        })
      )
    } finally {
      unregisterSshGitProvider('ssh-1')
      unregisterSshFilesystemProvider('ssh-1')
    }
  })

  it('honors split setup placement for SSH worktrees without startup agents', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/mobile-setup-split',
      head: 'def',
      branch: 'refs/heads/mobile-setup-split',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-horizontal' as const
      }),
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse') {
          return {
            stdout: '/remote/repo/.git/worktrees/mobile-setup-split/orca/setup-runner.sh\n',
            stderr: ''
          }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({ isBinary: false, content: 'hooks:\n' }),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    vi.mocked(getEffectiveHooksFromConfig).mockReturnValue({
      scripts: { setup: 'pnpm worktree:setup' }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-remote-initial' })
      .mockResolvedValueOnce({ id: 'pty-remote-setup-split' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-remote-split' })
    registerSshGitProvider('ssh-1', provider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-setup-split',
        setupDecision: 'run'
      })

      expect(spawn).toHaveBeenCalledTimes(2)
      const initialEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
      const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
      expect(setupEnv.ORCA_TAB_ID).toBe(initialEnv.ORCA_TAB_ID)
      const initialLeafId = initialEnv.ORCA_PANE_KEY!.slice(`${initialEnv.ORCA_TAB_ID!}:`.length)
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-remote-setup-split',
          tabId: initialEnv.ORCA_TAB_ID,
          activate: false,
          splitFromLeafId: initialLeafId,
          splitDirection: 'horizontal'
        })
      )
    } finally {
      unregisterSshGitProvider('ssh-1')
      unregisterSshFilesystemProvider('ssh-1')
    }
  })

  it('removes SSH-backed runtime worktrees through the SSH git provider', async () => {
    vi.mocked(listWorktrees).mockClear()
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      })
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await runtime.removeManagedWorktree('path:/remote/feature', true)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.removeWorktree).toHaveBeenCalledWith('/remote/feature', true)
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(`${TEST_REPO_ID}::/remote/feature`)
  })

  it('rejects SSH-backed runtime removal of the main worktree before provider deletion', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      })
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.removeManagedWorktree('path:/remote/repo', true)).rejects.toThrow(
        'Refusing to delete protected worktree path: /remote/repo'
      )
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.removeWorktree).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('reads SSH repo hooks through the SSH filesystem provider', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: 'C:/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  setup: pnpm install\n',
        isBinary: false
      })
    }
    vi.mocked(parseOrcaYaml).mockReturnValue({ scripts: { setup: 'pnpm install' } })
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.getRepoHooks('id:repo-1')).resolves.toMatchObject({
        hasHooksFile: true,
        hooks: { scripts: { setup: 'pnpm install' } },
        source: 'orca.yaml',
        setupTrust: {
          contentHash: '005d0b7e5c261dcc5e2f8568e69a0b30e889a3275b55b18ec20a7deef0081e90',
          scriptContent: 'pnpm install'
        }
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\orca.yaml')
    expect(hasHooksFile).not.toHaveBeenCalled()
    expect(getEffectiveHooks).not.toHaveBeenCalled()
  })

  it('hashes only the shared orca.yaml setup script for local run-both hooks', async () => {
    vi.mocked(hasHooksFile).mockReturnValue(true)
    vi.mocked(loadHooks).mockReturnValue({ scripts: { setup: 'echo yaml setup' } })
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { setup: 'echo yaml setup\necho local setup' }
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: TEST_REPO_PATH,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          hookSettings: {
            commandSourcePolicy: 'run-both' as const,
            scripts: { setup: 'echo local setup' }
          }
        }
      ]
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.getRepoHooks('id:repo-1')).resolves.toMatchObject({
      hooks: { scripts: { setup: 'echo yaml setup\necho local setup' } },
      setupTrust: {
        contentHash: '9bc9f57699fe0390d263cca1aec01235cccc8fa5fc87cd87fd51ba1c8483ec84',
        scriptContent: 'echo yaml setup'
      }
    })
  })

  it('uses remote path joins for SSH hook checks and issue-command files', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: 'C:/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => ({
        content: filePath.endsWith('orca.yaml')
          ? 'scripts:\n  setup: pnpm install\n'
          : filePath.endsWith('.gitignore')
            ? 'node_modules\n'
            : 'Fix it',
        isBinary: false
      })),
      writeFile: vi.fn().mockResolvedValue(undefined),
      createDir: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toMatchObject({
        hasHooks: true,
        mayNeedUpdate: false
      })
      await expect(runtime.readRepoIssueCommand('id:repo-1')).resolves.toMatchObject({
        localContent: 'Fix it',
        effectiveContent: 'Fix it',
        localFilePath: 'C:\\remote\\repo\\.orca\\issue-command'
      })
      await expect(runtime.writeRepoIssueCommand('id:repo-1', 'Ship it')).resolves.toEqual({
        ok: true
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\orca.yaml')
    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\.orca\\issue-command')
    expect(fsProvider.createDir).toHaveBeenCalledWith('C:\\remote\\repo\\.orca')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:\\remote\\repo\\.orca\\issue-command',
      'Ship it\n'
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:\\remote\\repo\\.gitignore',
      'node_modules\n.orca\n'
    )
  })

  it('resolves SSH issue commands from shared orca.yaml and deletes empty overrides', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    vi.mocked(parseOrcaYaml).mockReturnValue({
      scripts: {},
      issueCommand: 'claude -p "Fix #{{issue}}"'
    })
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('.orca/issue-command')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        if (filePath.endsWith('orca.yaml')) {
          return { content: 'issueCommand: claude -p "Fix #{{issue}}"', isBinary: false }
        }
        return { content: '', isBinary: false }
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      createDir: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.readRepoIssueCommand('id:repo-1')).resolves.toMatchObject({
        localContent: null,
        sharedContent: 'claude -p "Fix #{{issue}}"',
        effectiveContent: 'claude -p "Fix #{{issue}}"',
        localFilePath: '/remote/repo/.orca/issue-command',
        source: 'shared'
      })
      await expect(runtime.writeRepoIssueCommand('id:repo-1', '   ')).resolves.toEqual({
        ok: true
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/orca.yaml')
    expect(fsProvider.deletePath).toHaveBeenCalledWith('/remote/repo/.orca/issue-command', false)
    expect(fsProvider.writeFile).not.toHaveBeenCalledWith(
      '/remote/repo/.orca/issue-command',
      expect.anything()
    )
  })

  it('allows host integration slug helpers for SSH repos through provider-aware GitHub clients', async () => {
    getIssueMock.mockResolvedValueOnce({ number: 12, title: 'Remote issue' })
    listGitHubIssuesMock.mockResolvedValueOnce({
      items: [{ number: 7, title: 'Remote issue list item' }]
    })
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await expect(runtime.getRepoSlug('id:repo-1')).resolves.toBeNull()
    await expect(runtime.getRepoIssue('id:repo-1', 12)).resolves.toEqual({
      number: 12,
      title: 'Remote issue'
    })
    await expect(runtime.listRepoIssues('id:repo-1', 10)).resolves.toEqual([
      { number: 7, title: 'Remote issue list item' }
    ])
    expect(getIssueMock).toHaveBeenCalledWith('/remote/repo', 12, 'ssh-1')
    expect(listGitHubIssuesMock).toHaveBeenCalledWith('/remote/repo', 10, undefined, 'ssh-1')
  })

  it('rejects hosted review worktree selectors outside the selected repo', async () => {
    vi.mocked(listWorktrees).mockImplementation(async (repoPath: string) => {
      if (repoPath === '/tmp/repo-b') {
        return [
          {
            path: '/tmp/worktree-b',
            head: 'def',
            branch: 'feature/bar',
            isBare: false,
            isMainWorktree: false
          }
        ]
      }
      return MOCK_GIT_WORKTREES
    })
    const repos = [
      {
        id: TEST_REPO_ID,
        path: TEST_REPO_PATH,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      },
      {
        id: 'repo-2',
        path: '/tmp/repo-b',
        displayName: 'repo-b',
        badgeColor: 'green',
        addedAt: 2
      }
    ]
    const multiRepoStore = {
      ...store,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id)
    }
    const runtime = new OrcaRuntimeService(multiRepoStore as never)

    await expect(
      runtime.getHostedReviewCreationEligibility({
        repoSelector: 'id:repo-1',
        worktreeSelector: 'id:repo-2::/tmp/worktree-b',
        branch: 'feature/bar',
        base: 'main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 1,
        behind: 0
      })
    ).rejects.toThrow('Access denied: worktree does not belong to repository')
    await expect(
      runtime.createHostedReview({
        repoSelector: 'id:repo-1',
        worktreeSelector: 'id:repo-2::/tmp/worktree-b',
        provider: 'github',
        base: 'main',
        head: 'feature/bar',
        title: 'Create PR',
        body: '',
        draft: false
      })
    ).rejects.toThrow('Access denied: worktree does not belong to repository')

    expect(getHostedReviewCreationEligibilityMock).not.toHaveBeenCalled()
    expect(createHostedReviewMock).not.toHaveBeenCalled()
  })

  it('passes SSH connection context through hosted review creation flows', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await runtime.getHostedReviewCreationEligibility({
      repoSelector: `id:${TEST_REPO_ID}`,
      branch: 'feature/ssh',
      base: 'main',
      hasUncommittedChanges: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0
    })
    await runtime.createHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'main',
      head: 'feature/ssh',
      title: 'Feature SSH',
      body: '',
      draft: false
    })

    expect(getHostedReviewCreationEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/remote/repo',
        connectionId: 'ssh-1',
        branch: 'feature/ssh'
      })
    )
    expect(createHostedReviewMock).toHaveBeenCalledWith(
      '/remote/repo',
      expect.objectContaining({
        provider: 'github',
        head: 'feature/ssh',
        title: 'Feature SSH'
      }),
      'ssh-1'
    )
  })

  it('treats SSH worktree drift as unknown without local git probes', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(getDefaultBaseRef).mockClear()
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getWorktreeMeta: () => null
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.probeWorktreeDrift('path:/remote/repo')).resolves.toBeNull()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.listWorktrees).toHaveBeenCalledWith('/remote/repo')
    expect(getDefaultBaseRef).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('deduplicates runtime repo paths with Windows/UNC comparison semantics', async () => {
    const added: Record<string, unknown>[] = []
    const uncStore = {
      ...store,
      getRepos: () => [
        {
          id: 'repo-unc',
          path: '//Server/Share/Repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'folder'
        },
        ...added
      ],
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => [...uncStore.getRepos()].find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(uncStore as never)

    const repo = await runtime.addRepo('//server/share/repo', 'folder')

    expect(repo).toMatchObject({ id: 'repo-unc', path: '//Server/Share/Repo' })
    expect(added).toHaveLength(0)
  })

  it('browses runtime server directories before projects are added', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-browse-'))
    try {
      await mkdir(join(tempRoot, 'zeta'))
      await mkdir(join(tempRoot, 'alpha'))
      await writeFile(join(tempRoot, 'readme.md'), '# Readme\n')
      const runtime = new OrcaRuntimeService(store)

      const result = await runtime.browseServerDir(tempRoot)

      expect(result.resolvedPath).toBe(tempRoot)
      expect(result.entries).toEqual([
        { name: 'alpha', isDirectory: true, isSymlink: false },
        { name: 'zeta', isDirectory: true, isSymlink: false },
        { name: 'readme.md', isDirectory: false, isSymlink: false }
      ])
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('defaults runtime addRepo badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(colorStore as never)

    const repo = await runtime.addRepo('/tmp/runtime-add-default', 'folder')

    expect(repo.badgeColor).toBe(DEFAULT_REPO_BADGE_COLOR)
    expect(added).toEqual([expect.objectContaining({ badgeColor: DEFAULT_REPO_BADGE_COLOR })])
  })

  it('prepares the runtime worktree root when adding a repo', async () => {
    const added: Record<string, unknown>[] = []
    const runtimeStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const repo = await runtime.addRepo('/tmp/runtime-add-root-prep', 'folder')

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, repo)
  })

  it('defaults runtime createRepo badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(colorStore as never)
    const parentDir = await mkdtemp('/tmp/orca-runtime-create-')
    try {
      const result = await runtime.createRepo(parentDir, 'runtime-create-default', 'folder')
      if ('error' in result) {
        throw new Error(result.error)
      }

      expect(result).toHaveProperty('repo.badgeColor', DEFAULT_REPO_BADGE_COLOR)
      expect(added).toEqual([expect.objectContaining({ badgeColor: DEFAULT_REPO_BADGE_COLOR })])
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('creates a missing runtime parent before creating the project directory', async () => {
    const added: Record<string, unknown>[] = []
    const createStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(createStore as never)
    const tempRoot = await mkdtemp('/tmp/orca-runtime-create-parent-')
    const parentDir = join(tempRoot, 'orca', 'projects')
    try {
      const result = await runtime.createRepo(parentDir, 'first-project', 'folder')
      if ('error' in result) {
        throw new Error(result.error)
      }

      expect((await lstat(parentDir)).isDirectory()).toBe(true)
      expect((await lstat(join(parentDir, 'first-project'))).isDirectory()).toBe(true)
      expect(result).toHaveProperty('repo.path', join(parentDir, 'first-project'))
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('prepares the runtime worktree root when creating a repo', async () => {
    const added: Record<string, unknown>[] = []
    const runtimeStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const parentDir = await mkdtemp('/tmp/orca-runtime-create-root-prep-')
    try {
      const result = await runtime.createRepo(parentDir, 'runtime-create-root-prep', 'folder')
      if ('error' in result) {
        throw new Error(result.error)
      }

      expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, result.repo)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('preserves existing badgeColor on runtime createRepo dedupe', async () => {
    const existing = {
      id: 'runtime-existing-create',
      path: '/tmp/runtime-existing-create',
      displayName: 'runtime-existing-create',
      badgeColor: '#14b8a6',
      addedAt: 1,
      kind: 'folder' as const
    }
    const colorStore = {
      ...store,
      getRepos: () => [existing]
    }
    const runtime = new OrcaRuntimeService(colorStore as never)

    const result = await runtime.createRepo('/tmp', 'runtime-existing-create', 'folder')

    expect(result).toEqual({ repo: existing })
    expect(result).toHaveProperty('repo.badgeColor', '#14b8a6')
  })

  it('defaults runtime cloneRepo badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'wslAwareSpawn')
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc as never
    })
    const runtime = new OrcaRuntimeService(colorStore as never)

    try {
      const repo = await runtime.cloneRepo('https://example.com/repo-badge-color.git', '/tmp')
      expect(repo.badgeColor).toBe(DEFAULT_REPO_BADGE_COLOR)
      expect(added).toEqual([
        expect.objectContaining({
          badgeColor: DEFAULT_REPO_BADGE_COLOR,
          externalWorktreeVisibility: 'hide',
          externalWorktreeVisibilityLegacy: false
        })
      ])
      expect(repo.externalWorktreeVisibility).toBe('hide')
      expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(colorStore, repo)
    } finally {
      spawnSpy.mockRestore()
    }
  })

  it('preserves existing badgeColor on runtime cloneRepo folder->git dedupe upgrade', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'wslAwareSpawn')
    spawnSpy.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc as never
    })
    const existing = {
      id: 'runtime-folder-upgrade',
      path: '/tmp/repo-badge-color',
      displayName: 'repo-badge-color',
      badgeColor: '#ec4899',
      addedAt: 1,
      kind: 'folder' as const
    }
    const updates: { id: string; updates: Record<string, unknown> }[] = []
    const upgraded = { ...existing, kind: 'git' as const }
    const colorStore = {
      ...store,
      getRepos: () => [existing],
      updateRepo: (id: string, repoUpdates: Record<string, unknown>) => {
        updates.push({ id, updates: repoUpdates })
        return upgraded as never
      }
    }
    const runtime = new OrcaRuntimeService(colorStore as never)

    try {
      const repo = await runtime.cloneRepo('https://example.com/repo-badge-color.git', '/tmp')
      expect(updates).toEqual([{ id: existing.id, updates: { kind: 'git' } }])
      expect(repo).toEqual(upgraded)
      expect(repo.badgeColor).toBe('#ec4899')
      expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(colorStore, upgraded)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
    }
  })

  it('prepares the runtime worktree root when worktree base path changes', async () => {
    const repo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git' as const
    }
    const updated = { ...repo, worktreeBasePath: '../worktrees' }
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined) as never,
      updateRepo: vi.fn(() => updated as never)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.updateRepo(repo.id, { worktreeBasePath: '../worktrees' })).resolves.toBe(
      updated
    )

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, updated)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('prepares the runtime worktree root when repo-backed project host setup base path changes', () => {
    const repo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git' as const,
      worktreeBasePath: '../worktrees'
    }
    const result = {
      project: { id: 'project-1', displayName: 'Repo' },
      setup: { id: 'setup-1', projectId: 'project-1', repoId: repo.id, hostId: 'local' },
      repo
    }
    const runtimeStore = {
      ...store,
      updateProjectHostSetup: vi.fn(() => result as never)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    expect(
      runtime.updateProjectHostSetup({
        setupId: 'setup-1',
        updates: { worktreeBasePath: '../worktrees' }
      })
    ).toBe(result)

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(runtimeStore, repo)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('rejects runtime cloneRepo dot-segment URLs before spawning git', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'wslAwareSpawn')
    const runtime = createRuntime()
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const destination = join(tempRoot, 'destination')

    try {
      await expect(runtime.cloneRepo('file:///tmp/source/.', destination)).rejects.toThrow(
        'Invalid repository name derived from URL'
      )
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects runtime cloneRepo parent-segment URLs before spawning git', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'wslAwareSpawn')
    const runtime = createRuntime()
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const destination = join(tempRoot, 'destination')

    try {
      await expect(runtime.cloneRepo('file:///tmp/source/..', destination)).rejects.toThrow(
        'Invalid repository name derived from URL'
      )
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('removes an owned runtime clone target when git exits unsuccessfully', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'wslAwareSpawn')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockReturnValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')

    try {
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await writeFile(join(clonePath, 'partial.txt'), 'git wrote this before failing')
      proc.stderr.emit('data', Buffer.from('fatal: repository not found\n'))
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed: fatal: repository not found')
      await expect(lstat(clonePath)).rejects.toThrow()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('preserves an existing runtime clone target when git exits unsuccessfully', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'wslAwareSpawn')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockReturnValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')

    try {
      await mkdir(clonePath)
      await writeFile(join(clonePath, 'user-file.txt'), 'keep me')
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed')
      await expect(lstat(join(clonePath, 'user-file.txt'))).resolves.toBeTruthy()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('skips runtime clone failure cleanup when the owned target is replaced', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'wslAwareSpawn')
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    proc.stderr = new EventEmitter()
    spawnSpy.mockReturnValue(proc as never)
    const runtime = createRuntime()
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))
    const clonePath = join(destination, 'repo-badge-color')
    const replacementFile = join(clonePath, 'replacement.txt')

    try {
      const clonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await rm(clonePath, { recursive: true, force: true })
      await mkdir(clonePath)
      await writeFile(replacementFile, 'new owner')
      proc.emit('close', 128, null)

      await expect(clonePromise).rejects.toThrow('Clone failed')
      await expect(lstat(replacementFile)).resolves.toBeTruthy()
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('serializes concurrent runtime clones for the same target', async () => {
    const spawnSpy = vi.spyOn(gitRunner, 'wslAwareSpawn')
    const firstProc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    firstProc.stderr = new EventEmitter()
    spawnSpy.mockReturnValueOnce(firstProc as never)
    const added: Record<string, unknown>[] = []
    const colorStore = {
      ...store,
      getRepos: () => [...added] as never,
      addRepo: (repo: Record<string, unknown>) => {
        added.push(repo)
      },
      getRepo: (id: string) => added.find((repo) => repo.id === id) as never
    }
    const runtime = new OrcaRuntimeService(colorStore as never)
    const destination = await mkdtemp(join(tmpdir(), 'orca-runtime-clone-'))

    try {
      const firstClonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      const secondClonePromise = runtime.cloneRepo(
        'https://example.com/repo-badge-color.git',
        destination
      )
      await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setImmediate(resolve))
      expect(spawnSpy).toHaveBeenCalledTimes(1)

      firstProc.emit('close', 0, null)
      await expect(firstClonePromise).resolves.toMatchObject({
        path: join(destination, 'repo-badge-color')
      })
      await expect(secondClonePromise).resolves.toMatchObject({
        path: join(destination, 'repo-badge-color')
      })
      expect(spawnSpy).toHaveBeenCalledTimes(1)
    } finally {
      spawnSpy.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('associates controller PTYs with mixed-case Windows and UNC cwd paths', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: 'C:\\Repo',
        head: 'abc',
        branch: 'feature/windows',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '//Server/Share/Repo',
        head: 'def',
        branch: 'feature/unc',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'pty-windows', cwd: 'c:\\repo\\src', title: 'Windows shell' },
        { id: 'pty-unc', cwd: '//server/share/repo/src', title: 'UNC shell' }
      ]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    const terminals = await runtime.listTerminals()

    expect(terminals.terminals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worktreeId: `${TEST_REPO_ID}::C:\\Repo`,
          worktreePath: 'C:\\Repo'
        }),
        expect.objectContaining({
          worktreeId: `${TEST_REPO_ID}:://Server/Share/Repo`,
          worktreePath: '//Server/Share/Repo'
        })
      ])
    )
  })

  it('uses OSC titles rather than controller process names for rendererless PTYs', async () => {
    const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: null
    })

    runtime.onPtyData(ptyId, '\x1b]0;Codex\x07', 123)

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: 'Codex'
    })

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: 'Codex'
    })
  })

  it('returns OSC titles from headless main terminal snapshots', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07hello\n', 100)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot).toMatchObject({
      source: 'headless',
      lastTitle: 'Codex working'
    })
  })

  it('adopts renderer-seeded titles into headless main terminal snapshots', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'renderer scrollback\n',
      cols: 100,
      rows: 30,
      lastTitle: 'Renderer seeded Codex'
    })
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true,
      getSize: () => ({ cols: 100, rows: 30 })
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', 'live output without title\n', 100)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot).toMatchObject({
      source: 'headless',
      lastTitle: 'Renderer seeded Codex'
    })
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: expect.any(Number),
      altScreenForcesZeroRows: true
    })
  })

  it('returns cwd metadata from seeded headless main terminal snapshots', async () => {
    const runtime = createRuntime()

    runtime.seedHeadlessTerminal(
      'pty-1',
      'restored scrollback\n',
      { cols: 100, rows: 30 },
      {
        cwd: '/projects/restored'
      }
    )

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot).toMatchObject({
      source: 'headless',
      cwd: '/projects/restored'
    })
  })

  it('emits explicit OSC 9999 agent status from runtime PTY data', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `tab-1:${leafId}`
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData(
      'pty-1',
      'before\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07after',
      123
    )

    expect(statuses).toEqual([
      {
        ptyId: 'pty-1',
        source: 'mounted-leaf',
        paneKey,
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        connectionId: null,
        payload: {
          state: 'working',
          prompt: 'ship it',
          agentType: 'codex'
        }
      }
    ])
  })

  it('stamps SSH connection identity on runtime terminal status', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-ssh'
        }
      ]
    })
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh', '\x1b]9999;{"state":"working","agentType":"codex"}\x07', 123)

    expect(statuses).toEqual([
      expect.objectContaining({
        ptyId: 'pty-ssh',
        source: 'mounted-leaf',
        connectionId: 'ssh-conn-1',
        payload: expect.objectContaining({
          state: 'working',
          agentType: 'codex'
        })
      })
    ])
  })

  it('infers restored SSH connection identity from app-scoped PTY ids', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    const ptyId = 'ssh:ssh-restored@@relay-pty'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })

    runtime.onPtyData(ptyId, '\x1b]9999;{"state":"working","agentType":"codex"}\x07', 123)

    expect(statuses).toEqual([
      expect.objectContaining({
        ptyId,
        connectionId: 'ssh-restored',
        payload: expect.objectContaining({
          state: 'working',
          agentType: 'codex'
        })
      })
    ])
  })

  it('preserves OSC 9999 parser state for rendererless background PTYs', async () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'worker'
    })
    const spawnedEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const paneKey = expectStablePaneKeyEnv(spawnedEnv)

    runtime.onPtyData('pty-bg', 'before\x1b]999', 123)
    runtime.onPtyData('pty-bg', '9;{"state":"done","prompt":"ok"}\x1b\\after', 124)

    expect(statuses).toEqual([
      {
        ptyId: 'pty-bg',
        source: 'pty-record',
        paneKey,
        tabId: spawnedEnv.ORCA_TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        connectionId: null,
        payload: {
          state: 'done',
          prompt: 'ok'
        }
      }
    ])
  })

  it('continues terminal agent status fanout when a callback throws', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => {
        statuses.push(event)
        if (statuses.length === 1) {
          throw new Error('status listener failed')
        }
      }
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","prompt":"one","agentType":"codex"}\x07' +
        '\x1b]9999;{"state":"done","prompt":"two","agentType":"codex"}\x07',
      123
    )

    expect(statuses.map((event) => event.payload.prompt)).toEqual(['one', 'two'])
    expect(errorSpy).toHaveBeenCalledWith(
      '[runtime] terminal agent status listener threw',
      expect.objectContaining({
        ptyId: 'pty-1',
        paneKey: `tab-1:${leafId}`,
        state: 'working',
        agentType: 'codex',
        err: expect.any(Error)
      })
    )
  })

  it('reads bounded terminal output and writes through the PTY controller', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', '\u001b[32mhello\u001b[0m\nworld\n', 123)

    const [terminal] = (await runtime.listTerminals()).terminals
    const read = await runtime.readTerminal(terminal.handle)
    expect(read).toMatchObject({
      handle: terminal.handle,
      status: 'running',
      tail: ['hello', 'world'],
      truncated: false,
      nextCursor: expect.any(String)
    })

    const send = await runtime.sendTerminal(terminal.handle, {
      text: 'continue',
      enter: true
    })
    expect(send).toMatchObject({
      handle: terminal.handle,
      accepted: true
    })
    expect(writes).toEqual(['continue', '\r'])
  })

  it('creates visible terminal sessions without asking the renderer to focus a tab', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const createTerminal = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal,
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'worker'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: TEST_WORKTREE_PATH,
        command: 'codex',
        worktreeId: TEST_WORKTREE_ID,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    expect(result).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      title: 'worker',
      surface: 'visible'
    })
    expect(result.handle).toMatch(/^term_/)
    expect(createTerminal).not.toHaveBeenCalled()
    // Why: hook-based agent status keys off `${tabId}:${leafId}`, so main must
    // pre-allocate the tabId and stamp ORCA_PANE_KEY/TAB_ID/WORKTREE_ID into
    // the PTY env before spawn. The same tabId is then handed to the renderer
    // via `revealTerminalSession` so adoption preserves attribution.
    const spawnCall = spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined
    const spawnedEnv = spawnCall?.env ?? {}
    expectStablePaneKeyEnv(spawnedEnv)
    const spawnedLeafId = spawnedEnv.ORCA_PANE_KEY.slice(`${spawnedEnv.ORCA_TAB_ID}:`.length)
    expect(spawnedEnv.ORCA_WORKTREE_ID).toBe(TEST_WORKTREE_ID)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-bg',
      title: 'worker',
      activate: false,
      tabId: spawnedEnv.ORCA_TAB_ID,
      leafId: spawnedLeafId
    })
  })

  it.each([
    { label: 'canonical folder workspace selector', selector: TEST_FOLDER_WORKSPACE_KEY },
    { label: 'id-prefixed folder workspace selector', selector: `id:${TEST_FOLDER_WORKSPACE_KEY}` }
  ])('creates background terminal sessions for a $label', async ({ selector }) => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-workspace-'))
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(selector, {
        command: 'codex',
        title: 'multi-repo worker'
      })
    ).resolves.toMatchObject({
      worktreeId: TEST_FOLDER_WORKSPACE_KEY,
      title: 'multi-repo worker',
      surface: 'background'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const spawnedEnv = spawnCall?.env ?? {}
    expect(spawnCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expectStablePaneKeyEnv(spawnedEnv)
    expect(spawnedEnv.ORCA_WORKSPACE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(spawnedEnv.ORCA_PROJECT_GROUP_ID).toBe(TEST_FOLDER_PROJECT_GROUP_ID)
    expect(spawnedEnv.ORCA_WORKSPACE_ROOT).toBe(folderPath)
    expect(spawnedEnv.ORCA_WORKTREE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
  })

  it('rejects folder workspace terminal creation when the backing path is missing', async () => {
    const missingPath = join(tmpdir(), `orca-missing-folder-workspace-${randomUUID()}`)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath: missingPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: missingPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(runtime.createTerminal(TEST_FOLDER_WORKSPACE_KEY)).rejects.toThrow(
      'folder_workspace_path_missing'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects folder workspace folderPath updates when the new path is missing', async () => {
    const missingPath = join(tmpdir(), `orca-missing-folder-update-${randomUUID()}`)
    const folderWorkspace = makeFolderWorkspace()
    const runtimeStore = {
      ...createFolderWorkspaceRuntimeStore(folderWorkspace),
      updateFolderWorkspace: vi.fn()
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(
      runtime.updateFolderWorkspace(TEST_FOLDER_WORKSPACE_ID, { folderPath: missingPath })
    ).rejects.toThrow('folder_workspace_path_missing')
    expect(runtimeStore.updateFolderWorkspace).not.toHaveBeenCalled()
  })

  it('enables Claude Agent Teams only for direct Claude launches when configured in-process', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'in-process' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: "claude 'hello'"
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: "echo ok; claude 'hello'"
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex'
    })

    const directClaude = spawn.mock.calls[0]?.[0] as {
      command?: string
      env?: Record<string, string>
    }
    const compoundClaude = spawn.mock.calls[1]?.[0] as {
      command?: string
      env?: Record<string, string>
    }
    const normalAgent = spawn.mock.calls[2]?.[0] as {
      command?: string
      env?: Record<string, string>
    }

    expect(directClaude.command).toBe("claude --teammate-mode in-process 'hello'")
    expect(directClaude.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
    expect(directClaude.env?.TMUX).toBeUndefined()

    expect(compoundClaude.command).toBe("echo ok; claude 'hello'")
    expect(compoundClaude.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    expect(compoundClaude.env?.TMUX).toBeUndefined()

    expect(normalAgent.command).toBe('codex')
    expect(normalAgent.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    expect(normalAgent.env?.TMUX).toBeUndefined()
  })

  it('adopts renderer pane identity for remote runtime terminal creates', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-remote-runtime'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      focus: false,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: `${tabId}:${leafId}`,
        ORCA_TAB_ID: tabId
      }
    })

    const spawnedEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expect(spawnedEnv.ORCA_TAB_ID).toBe(tabId)
    expect(spawnedEnv.ORCA_PANE_KEY).toBe(`${tabId}:${leafId}`)
  })

  it('does not adopt web mirror ids as host terminal ids', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'web-terminal-host-tab-1'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      focus: false,
      tabId,
      leafId
    })

    const spawnedEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expect(spawnedEnv.ORCA_TAB_ID).not.toBe(tabId)
    expect(spawnedEnv.ORCA_TAB_ID).not.toMatch(/^web-terminal-/)
    expect(spawnedEnv.ORCA_PANE_KEY).toMatch(`${spawnedEnv.ORCA_TAB_ID}:`)
  })

  it('creates background terminal sessions while the renderer graph is unavailable', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('falls back to background terminal creation for renderer-backed requests without a renderer window', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'codex',
        rendererBacked: true
      })
    ).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'codex',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('splits visible pty-backed terminal sessions through the parent renderer tab', async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-source' })
      .mockResolvedValueOnce({ id: 'pty-split' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const splitTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal,
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const sourceEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const sourceLeafId = sourceEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).resolves.toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: sourceEnv.ORCA_TAB_ID,
      paneRuntimeId: -1
    })

    const splitEnv =
      (spawn.mock.calls[1]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const splitLeafId = splitEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)
    expect(splitTerminal).not.toHaveBeenCalled()
    expect(splitEnv.ORCA_TAB_ID).toBe(sourceEnv.ORCA_TAB_ID)
    expect(splitEnv.ORCA_WORKTREE_ID).toBe(TEST_WORKTREE_ID)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-split',
      title: null,
      activate: true,
      tabId: sourceEnv.ORCA_TAB_ID,
      leafId: splitLeafId,
      splitFromLeafId: sourceLeafId,
      splitDirection: 'vertical'
    })
  })

  it('splits folder workspace pty-backed terminal sessions with folder cwd and env', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-split-'))
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-folder-source' })
      .mockResolvedValueOnce({ id: 'pty-folder-split' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(TEST_FOLDER_WORKSPACE_KEY)
    const sourceCall = spawn.mock.calls[0]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const sourceEnv = sourceCall?.env ?? {}
    const sourceLeafId = sourceEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).resolves.toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: sourceEnv.ORCA_TAB_ID,
      paneRuntimeId: -1
    })

    const splitCall = spawn.mock.calls[1]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const splitEnv = splitCall?.env ?? {}
    const splitLeafId = splitEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)
    expect(sourceCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expect(splitCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expectStablePaneKeyEnv(splitEnv)
    expect(splitEnv.ORCA_TAB_ID).toBe(sourceEnv.ORCA_TAB_ID)
    expect(splitEnv.ORCA_WORKSPACE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(splitEnv.ORCA_PROJECT_GROUP_ID).toBe(TEST_FOLDER_PROJECT_GROUP_ID)
    expect(splitEnv.ORCA_WORKSPACE_ROOT).toBe(folderPath)
    expect(splitEnv.ORCA_WORKTREE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(TEST_FOLDER_WORKSPACE_KEY, {
      ptyId: 'pty-folder-split',
      title: null,
      activate: true,
      tabId: sourceEnv.ORCA_TAB_ID,
      leafId: splitLeafId,
      splitFromLeafId: sourceLeafId,
      splitDirection: 'vertical'
    })
  })

  it('returns a background handle when inactive tab adoption fails after spawn', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const revealTerminalSession = vi.fn().mockRejectedValue(new Error('Renderer timed out'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    try {
      await expect(runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)).resolves.toMatchObject({
        worktreeId: TEST_WORKTREE_ID,
        surface: 'background',
        handle: expect.stringMatching(/^term_/)
      })
      const spawnCall = spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined
      const spawnedEnv = spawnCall?.env ?? {}
      expectStablePaneKeyEnv(spawnedEnv)
      const spawnedLeafId = spawnedEnv.ORCA_PANE_KEY.slice(`${spawnedEnv.ORCA_TAB_ID}:`.length)
      expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
        ptyId: 'pty-bg',
        title: null,
        activate: false,
        tabId: spawnedEnv.ORCA_TAB_ID,
        leafId: spawnedLeafId
      })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[terminal-create] failed to create inactive tab for pty-bg:'),
        expect.any(Error)
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('waits for exit on background terminal handles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const waiting = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 1000 })
    runtime.onPtyExit('pty-bg', 7)

    await expect(waiting).resolves.toMatchObject({
      handle,
      condition: 'exit',
      status: 'exited',
      exitCode: 7
    })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('drops retained PTY transcript memory when a background terminal exits', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.onPtyData(
      'pty-bg',
      `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')}`,
      100
    )
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'running',
      tail: expect.arrayContaining(['line-0'])
    })

    runtime.onPtyExit('pty-bg', 0)

    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            tailBuffer: string[]
            tailPartialLine: string
            tailLinesTotal: number
            tailTruncated: boolean
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toMatchObject({
      tailBuffer: [],
      tailPartialLine: '',
      tailLinesTotal: 0,
      tailTruncated: false
    })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'exited',
      tail: []
    })
  })

  it('bounds disconnected background PTY records and their synthetic handles', async () => {
    let nextPtyIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockImplementation(async () => ({ id: `pty-bg-${nextPtyIndex++}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const handles: string[] = []
    for (let index = 0; index < 140; index += 1) {
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      handles.push(handle)
      runtime.onPtyExit(`pty-bg-${index}`, 0)
    }

    const internals = runtime as unknown as {
      ptysById: Map<string, unknown>
      handles: Map<string, unknown>
      handleByPtyId: Map<string, string>
    }
    expect(internals.ptysById.size).toBeLessThanOrEqual(128)
    expect(internals.ptysById.has('pty-bg-0')).toBe(false)
    expect(internals.ptysById.has('pty-bg-139')).toBe(true)
    expect(internals.handleByPtyId.has('pty-bg-0')).toBe(false)
    expect(internals.handles.has(handles[0]!)).toBe(false)

    await expect(runtime.readTerminal(handles[0]!)).rejects.toThrow('terminal_handle_stale')
    await expect(runtime.readTerminal(handles.at(-1)!)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('keeps retained PTY transcript memory when controller refresh omits a record', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty('daemon-pty-1', TEST_WORKTREE_ID)
    runtime.onPtyData('daemon-pty-1', 'still live\npartial', 100)

    await runtime.listTerminals()

    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            connected: boolean
            tailBuffer: string[]
            tailPartialLine: string
            tailLinesTotal: number
          }
        >
      }
    ).ptysById.get('daemon-pty-1')
    expect(pty).toMatchObject({
      connected: false,
      tailBuffer: ['still live'],
      tailPartialLine: 'partial',
      tailLinesTotal: 1
    })
  })

  it('keeps retained PTY transcript memory when controller refresh fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        throw new Error('controller unavailable')
      }
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty('daemon-pty-1', TEST_WORKTREE_ID)
    runtime.onPtyData('daemon-pty-1', 'still live\npartial', 100)

    await runtime.listTerminals()

    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            connected: boolean
            tailBuffer: string[]
            tailPartialLine: string
            tailLinesTotal: number
          }
        >
      }
    ).ptysById.get('daemon-pty-1')
    expect(pty).toMatchObject({
      connected: true,
      tailBuffer: ['still live'],
      tailPartialLine: 'partial',
      tailLinesTotal: 1
    })
  })

  it('keeps retained PTY transcript memory when controller refresh times out', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: () => new Promise(() => {})
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.registerPty('daemon-pty-1', TEST_WORKTREE_ID)
      runtime.onPtyData('daemon-pty-1', 'still live\npartial', 100)

      const terminals = runtime.listTerminals()
      await vi.advanceTimersByTimeAsync(3_000)
      await terminals

      const pty = (
        runtime as unknown as {
          ptysById: Map<
            string,
            {
              connected: boolean
              tailBuffer: string[]
              tailPartialLine: string
              tailLinesTotal: number
            }
          >
        }
      ).ptysById.get('daemon-pty-1')
      expect(pty).toMatchObject({
        connected: true,
        tailBuffer: ['still live'],
        tailPartialLine: 'partial',
        tailLinesTotal: 1
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves tui-idle for adopted background PTY handles from the renderer title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-bg',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex ready',
          activeLeafId: 'pane-bg',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-bg',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane-bg',
          paneRuntimeId: 1,
          ptyId: 'pty-bg',
          paneTitle: null
        }
      ]
    })

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('does not treat a Codex launch title as tui-idle readiness', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-bg',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex YOLO',
            activeLeafId: 'pane-bg',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-bg',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane-bg',
            paneRuntimeId: 1,
            ptyId: 'pty-bg',
            paneTitle: null
          }
        ]
      })

      const waitPromise = runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(2_000)

      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves tui-idle from a Codex ready prompt preview', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        ' >_ OpenAI Codex (v0.131.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('resolves tui-idle from an Antigravity ready prompt preview', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData('pty-bg', antigravityReadyScreen('Gemini 4 Experimental (High)'), Date.now())

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('resolves tui-idle from an Antigravity prompt before the model line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Do you trust this workspace directory?\n',
        'Press t to trust\n',
        antigravityPromptBeforeModelReadyScreen('Gemini 3.5 Flash (High)')
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('resolves live-leaf tui-idle from an Antigravity ready prompt preview', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: null
        }
      ]
    })
    runtime.onPtyData('pty-1', antigravityReadyScreen(), Date.now())
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('resolves tui-idle from a Codex ready prompt even when stale startup lines remain', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Booting MCP server: computer-use(0s  esc to interrupt)\n',
        ' >_ OpenAI Codex (v0.132.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n',
        [
          'Starting MCP servers (0/2): codex_apps, computer-use (2s  esc to interrupt)',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug',
          'Run /review on my current changes gpt-5.5 high ~/orca/workspaces/orca/cli-debug\n'
        ].join('')
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('resolves tui-idle when a stale Codex prompt is followed by Antigravity readiness', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Do you trust this workspace directory?\n',
        'Press t to trust\n',
        antigravityReadyScreen(),
        '\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('resolves tui-idle when a stale Codex prompt is followed by the ready header', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Choose working directory to resume this session\n',
        'Press enter to continue\n',
        ' >_ OpenAI Codex (v0.132.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('returns a blocked wait result for Codex update prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Update available! 0.131.0 -> 0.132.0\n',
        '1. Update now\n',
        '2. Skip\n',
        'Press enter to continue\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-update-prompt'
    })
  })

  it('returns a blocked wait result for Codex workspace trust prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      'Do you trust this workspace directory?\n1. Yes\n2. No\n',
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-trust-workspace'
    })
  })

  it('returns a blocked wait result for Codex cwd selection prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Choose working directory to resume this session\n',
        '  Session = latest cwd recorded in the resumed session\n',
        '  Current = your current working directory\n',
        '  Press enter to continue\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-cwd-prompt'
    })
  })

  it('returns a blocked wait result for Codex model migration prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Codex just got an upgrade. Introducing gpt-5.1-codex-max.\n',
        'We recommend switching from gpt-5-codex to gpt-5.1-codex-max.\n',
        'Press enter to continue\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-model-migration-prompt'
    })
  })

  it('returns a blocked wait result for Codex startup hook review prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Hooks need review\n',
        '2 hooks are new or changed.\n',
        '1. Review hooks\n',
        '2. Trust all and continue\n',
        'Press enter to confirm or esc to go back\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-hooks-review-prompt'
    })
  })

  it('returns a blocked wait result for generic Codex interactive prompts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Would you like to grant these permissions?\n',
        '1. Yes, grant these permissions for this turn\n',
        '2. No, continue without permissions\n',
        'Press enter to confirm or esc to cancel\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      blockedReason: 'codex-interactive-prompt'
    })
  })

  it('does not classify unrelated press-enter prompts as Codex blocked prompts', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      runtime.onPtyData('pty-bg', 'Press enter to continue\n', Date.now())

      const waitPromise = runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(2_000)

      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves tui-idle for quiet background PTY agents without OSC titles', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'codex'
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      runtime.onPtyData('pty-bg', 'OpenAI Codex\n', Date.now())

      const waitPromise = runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 10_000
      })
      const waitAssertion = expect(waitPromise).resolves.toMatchObject({
        handle,
        condition: 'tui-idle',
        status: 'running'
      })

      await vi.advanceTimersByTimeAsync(6_000)

      await waitAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('splits text and enter writes for background terminal handles', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await runtime.sendTerminal(handle, { text: 'continue', enter: true })

    expect(writes).toEqual(['continue', '\r'])
  })

  it('reveals a background terminal session when focusing its handle', async () => {
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-adopted' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'worker'
    })

    await expect(runtime.focusTerminal(handle)).resolves.toMatchObject({
      handle,
      tabId: 'tab-adopted',
      worktreeId: TEST_WORKTREE_ID
    })
    // Why: createTerminal first reveal stamps activate/tabId; the focus reveal
    // is the second call and must reuse that pre-minted tabId so a retry after
    // an earlier reveal failure still adopts under the paneKey baked into env.
    expect(revealTerminalSession).toHaveBeenLastCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-bg',
      title: 'worker',
      tabId: expect.stringMatching(UUID_RE),
      leafId: expect.stringMatching(UUID_RE)
    })
  })

  it('reveals background terminal sessions with the freshest PTY title', async () => {
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-adopted' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'Claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude agents\x07', 100)

    await runtime.focusTerminal(handle)

    expect(revealTerminalSession).toHaveBeenLastCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({
        ptyId: 'pty-bg',
        title: 'claude agents'
      })
    )
  })

  it('rejects focusing an exited background terminal session', async () => {
    const revealTerminalSession = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    revealTerminalSession.mockClear()
    runtime.onPtyExit('pty-bg', 0)

    await expect(runtime.focusTerminal(handle)).rejects.toThrow('terminal_exited')
    expect(revealTerminalSession).not.toHaveBeenCalled()
  })

  it('renames background terminal handles without requiring a visible tab', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const renamed = await runtime.renameTerminal(handle, 'Worker')
    expect(renamed).toMatchObject({
      handle,
      title: 'Worker'
    })
    expect(renamed.tabId).not.toContain(':')
    await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
      tabId: renamed.tabId,
      title: 'Worker'
    })
  })

  it('keeps a background terminal handle stable while reveal adoption is racing', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      title: 'worker'
    })

    await runtime.focusTerminal(handle)
    ;(runtime as unknown as { handleByPtyId: Map<string, string> }).handleByPtyId.delete('pty-bg')

    await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
      handle,
      ptyId: 'pty-bg'
    })
  })

  it('clears terminal scrollback through the PTY controller and headless buffer', async () => {
    const clearBuffer = vi.fn().mockResolvedValue(undefined)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      clearBuffer
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')}\n`,
      123
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.clearTerminalBuffer(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      cleared: true
    })

    expect(clearBuffer).toHaveBeenCalledWith('pty-1')
    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot?.data).not.toContain('line-0')
  })

  it('waits for terminal exit and resolves with the exit status', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, { timeoutMs: 1000 })
    runtime.onPtyExit('pty-1', 7)

    await expect(waitPromise).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 7
    })
  })

  it('keeps partial-line output readable across cursor-based pagination', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'hel', 100)

    // Non-cursor reads include the partial line for UI display
    const firstRead = await runtime.readTerminal(terminal.handle)
    expect(firstRead.tail).toEqual(['hel'])
    expect(firstRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', 'lo', 101)

    // Cursor-based reads exclude partial lines to prevent duplication:
    // without this, the consumer would see "hello" now as a partial, then
    // see "hello" again as a completed line on the next read.
    const secondRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(firstRead.nextCursor)
    })
    expect(secondRead.tail).toEqual([])
    expect(secondRead.nextCursor).toBe('0')

    runtime.onPtyData('pty-1', '\nworld\n', 102)

    const thirdRead = await runtime.readTerminal(terminal.handle, {
      cursor: Number(secondRead.nextCursor)
    })
    expect(thirdRead.tail).toEqual(['hello', 'world'])
    expect(thirdRead.nextCursor).toBe('2')
  })

  it('paginates retained terminal output with explicit limits and truncation metadata', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 150 }, (_, index) => `line-${index}`).join('\n')}\n`,
      100
    )

    const preview = await runtime.readTerminal(terminal.handle)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail[0]).toBe('line-30')
    expect(preview.limited).toBe(true)
    expect(preview.oldestCursor).toBe('0')
    expect(preview.latestCursor).toBe('150')

    const defaultCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 0 })
    expect(defaultCursorRead.tail).toHaveLength(150)
    expect(defaultCursorRead.nextCursor).toBe('150')
    expect(defaultCursorRead.limited).toBe(false)

    const firstPage = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 50 })
    expect(firstPage.tail).toHaveLength(50)
    expect(firstPage.tail[0]).toBe('line-0')
    expect(firstPage.nextCursor).toBe('50')
    expect(firstPage.limited).toBe(true)
    expect(firstPage.truncated).toBe(false)

    const fractionalPage = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 0.5 })
    expect(fractionalPage.tail).toEqual(['line-0'])
    expect(fractionalPage.nextCursor).toBe('1')
    expect(fractionalPage.limited).toBe(true)

    const secondPage = await runtime.readTerminal(terminal.handle, {
      cursor: Number(firstPage.nextCursor),
      limit: 200
    })
    expect(secondPage.tail).toHaveLength(100)
    expect(secondPage.tail[0]).toBe('line-50')
    expect(secondPage.nextCursor).toBe('150')
    expect(secondPage.limited).toBe(false)

    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 2100 }, (_, index) => `later-${index}`).join('\n')}\n`,
      101
    )

    const staleCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 5 })
    expect(staleCursorRead.truncated).toBe(true)
    expect(staleCursorRead.oldestCursor).toBe('250')
    expect(staleCursorRead.tail).toEqual([
      'later-100',
      'later-101',
      'later-102',
      'later-103',
      'later-104'
    ])
    expect(staleCursorRead.nextCursor).toBe('255')

    const futureCursorRead = await runtime.readTerminal(terminal.handle, { cursor: 9999 })
    expect(futureCursorRead.tail).toEqual([])
    expect(futureCursorRead.nextCursor).toBe('2250')
    expect(futureCursorRead.limited).toBe(false)
  })

  // Why: PR #2553 fixed Orca CLI terminal reads so older retained output stays
  // reachable by cursor; this guards that pagination without allowing previews
  // to regress into full-transcript RPC payloads.
  it('keeps terminal read payloads bounded while retained output remains pageable', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const linePayload = 'x'.repeat(24)
    const lines = Array.from(
      { length: 2000 },
      (_, index) => `line-${index.toString().padStart(4, '0')}-${linePayload}`
    )
    runtime.onPtyData('pty-1', `${lines.join('\n')}\n`, 100)

    const preview = await runtime.readTerminal(terminal.handle)
    expect(Buffer.byteLength(JSON.stringify(preview), 'utf8')).toBeLessThan(10_000)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail[0]).toBe(lines.at(-120))
    expect(preview.limited).toBe(true)
    expect(preview.oldestCursor).toBe('0')
    expect(preview.nextCursor).toBe('2000')
    expect(preview.latestCursor).toBe('2000')

    const collected: string[] = []
    let cursor = Number(preview.oldestCursor)
    const latestCursor = Number(preview.latestCursor)
    for (let pageIndex = 0; cursor < latestCursor; pageIndex += 1) {
      expect(pageIndex).toBeLessThan(10)
      const page = await runtime.readTerminal(terminal.handle, { cursor, limit: 333 })
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(16_000)
      expect(page.tail.length).toBeGreaterThan(0)
      expect(page.tail.length).toBeLessThanOrEqual(333)
      expect(page.returnedLineCount).toBe(page.tail.length)

      collected.push(...page.tail)
      const nextCursor = Number(page.nextCursor)
      expect(nextCursor).toBeGreaterThan(cursor)
      cursor = nextCursor
    }

    expect(collected).toHaveLength(lines.length)
    expect(collected.findIndex((line, index) => line !== lines[index])).toBe(-1)
  })

  it('trims terminal read preview character budget without per-line array shifts', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    const lines = Array.from({ length: 120 }, (_, index) => `line-${index}-${'x'.repeat(400)}`)
    runtime.onPtyData('pty-1', `${lines.join('\n')}\n`, 100)
    // Why: xterm-headless uses Array.shift internally while draining writes;
    // this test guards read-preview trimming, not emulator parsing.
    await runtime.serializeMainTerminalBuffer('pty-1')

    const originalShift = Array.prototype.shift
    let shiftCallCount = 0
    Array.prototype.shift = function (...args) {
      shiftCallCount += 1
      return originalShift.apply(this, args)
    }
    let preview: Awaited<ReturnType<typeof runtime.readTerminal>>
    try {
      preview = await runtime.readTerminal(terminal.handle)
    } finally {
      Array.prototype.shift = originalShift
    }

    expect(preview.limited).toBe(true)
    expect(preview.tail.at(-1)).toBe(lines.at(-1))
    expect(preview.tail.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(32 * 1024)
    expect(shiftCallCount).toBe(0)
  })

  it('falls back to renderer visible screen when uncursored TUI tail is blank', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hClaude Code\r\nWorking on fix\r\nTool: Read\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '   ').join('\n')}\n`, 100)

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['Claude Code', 'Working on fix', 'Tool: Read'])
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('returns renderer visible screen lines through terminal.read RPC JSON result', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hClaude Code\r\nChecking files\r\nWaiting for input\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', `${Array.from({ length: 3000 }, () => '').join('\n')}\n`, 100)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRpcRequest('terminal.read', { terminal: terminal.handle })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toMatchObject({
      terminal: {
        handle: terminal.handle,
        status: 'running',
        tail: ['Claude Code', 'Checking files', 'Waiting for input']
      }
    })
  })

  it('does not use renderer visible-screen fallback for cursor transcript reads', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'Visible TUI\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '   \n', 100)

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0 })

    expect(read.tail).toEqual([''])
    expect(serializeBuffer).not.toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('does not use renderer visible-screen fallback for a short blank shell tail', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'shell prompt\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => true,
      serializeBuffer
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '\n\n', 100)

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['', ''])
    expect(serializeBuffer).not.toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 0,
      altScreenForcesZeroRows: false
    })
  })

  it('trims oversized terminal output bursts without per-line array shifts', async () => {
    const shiftSpy = vi.spyOn(Array.prototype, 'shift')
    const lines = Array.from({ length: 5000 }, (_, index) => `line-${index}`)
    const result = appendNormalizedToTailBuffer([], '', `${lines.join('\n')}\n`)
    const shiftCallCount = shiftSpy.mock.calls.length
    shiftSpy.mockRestore()

    expect(result.truncated).toBe(true)
    expect(result.lines).toHaveLength(2000)
    expect(result.lines.slice(0, 5)).toEqual([
      'line-3000',
      'line-3001',
      'line-3002',
      'line-3003',
      'line-3004'
    ])
    expect(shiftCallCount).toBe(0)
  })

  it('trims terminal tail character budget without per-line array shifts', () => {
    const shiftSpy = vi.spyOn(Array.prototype, 'shift')
    const lines = Array.from({ length: 1000 }, (_, index) => `line-${index}-${'x'.repeat(300)}`)
    const result = appendNormalizedToTailBuffer([], '', `${lines.join('\n')}\n`)
    const shiftCallCount = shiftSpy.mock.calls.length
    shiftSpy.mockRestore()

    let retainedChars = lines.reduce((sum, line) => sum + line.length, 0)
    let expectedStartIndex = 0
    while (expectedStartIndex < lines.length && retainedChars > 256 * 1024) {
      retainedChars -= lines[expectedStartIndex].length
      expectedStartIndex += 1
    }

    expect(result.truncated).toBe(true)
    expect(result.lines).toEqual(lines.slice(expectedStartIndex))
    expect(result.lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(256 * 1024)
    expect(shiftCallCount).toBe(0)
  })

  it('builds terminal previews without mapping the full retained tail', () => {
    const lines = Array.from({ length: 5000 }, (_, index) =>
      index % 2 === 0 ? `line-${index}` : '   '
    )
    const mapSpy = vi.spyOn(Array.prototype, 'map')

    const preview = buildPreview(lines, 'partial-tail')
    const mapCallCount = mapSpy.mock.calls.length
    mapSpy.mockRestore()

    expect(preview).toBe(
      ['line-4990', 'line-4992', 'line-4994', 'line-4996', 'line-4998', 'partial-tail'].join('\n')
    )
    expect(mapCallCount).toBe(0)
  })

  it('keeps recent PTY replay output capped without needing previous data for large chunks', () => {
    const previous = 'old-output'.repeat(1000)
    const data = 'new-output'.repeat(1000)
    const expected = `${previous}${data}`.slice(-4096)

    expect(appendRecentPtyOutput(previous, 'tail')).toBe(`${previous}tail`.slice(-4096))
    expect(appendRecentPtyOutput(previous, data)).toBe(expected)
    expect(appendRecentPtyOutput(undefined, data)).toBe(data.slice(-4096))
  })

  it('applies terminal redraw controls before retaining previews', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Working\rWorking 1s\rWorking 2s', 100)

    const carriageRead = await runtime.readTerminal(terminal.handle)
    expect(carriageRead.tail).toEqual(['Working 2s'])
    expect(carriageRead.latestCursor).toBe('0')

    runtime.onPtyData('pty-1', '\b\b3s', 101)
    const backspaceRead = await runtime.readTerminal(terminal.handle)
    expect(backspaceRead.tail).toEqual(['Working 3s'])
    expect(backspaceRead.latestCursor).toBe('0')

    runtime.onPtyData('pty-1', '\rDone\n', 102)
    const completedRead = await runtime.readTerminal(terminal.handle)
    expect(completedRead.tail).toEqual(['Done'])
    expect(completedRead.latestCursor).toBe('1')
  })

  it('applies ANSI terminal redraw controls before retaining previews', async () => {
    const cursorRedraw = appendNormalizedToTailBuffer([], '', 'Working 10%\x1b[3D25%')
    expect(cursorRedraw.partialLine).toBe('Working 25%')

    const eraseWithoutCarriageReturn = appendNormalizedToTailBuffer(
      [],
      'Downloading 10%',
      '\x1b[2K\x1b[1GDownloading 20%'
    )
    expect(eraseWithoutCarriageReturn.partialLine).toBe('Downloading 20%')

    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData(
      'pty-1',
      'Working\r\x1b[2K\x1b[1G\x1b[?25l\x1b[32mDone\x1b[0m\x1b]0;title\u0007\n',
      100
    )

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['Done'])
    expect(read.latestCursor).toBe('1')
  })

  it('bounds retained partial terminal output before preview reads', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData(
      'pty-1',
      `${Array.from({ length: 2000 }, (_, index) => `line-${index}`).join('\n')}\n`,
      99
    )
    runtime.onPtyData('pty-1', `${'x'.repeat(40_000)}tail-marker-0`, 100)
    type RetainedTailState = {
      tailBuffer: string[]
      tailPartialLine: string
      tailTruncated: boolean
    }
    const cappedPartialState = (
      runtime as unknown as {
        ptysById: Map<string, RetainedTailState>
      }
    ).ptysById.get('pty-1')
    const retainedLineBuffer = cappedPartialState?.tailBuffer
    for (let index = 1; index < 5; index += 1) {
      runtime.onPtyData('pty-1', `${'x'.repeat(40_000)}tail-marker-${index}`, 100 + index)
    }

    const retained = (
      runtime as unknown as {
        ptysById: Map<string, RetainedTailState>
      }
    ).ptysById.get('pty-1')
    expect(retained?.tailBuffer).toBe(retainedLineBuffer)
    expect(retained?.tailPartialLine).toHaveLength(4000)
    expect(retained?.tailPartialLine.endsWith('tail-marker-4')).toBe(true)
    expect(retained?.tailTruncated).toBe(true)

    const preview = await runtime.readTerminal(terminal.handle)
    expect(preview.tail).toHaveLength(120)
    expect(preview.tail.at(-1)).toHaveLength(4000)
    expect(preview.tail.at(-1)?.endsWith('tail-marker-4')).toBe(true)
    expect(preview.truncated).toBe(true)
    expect(preview.nextCursor).toBe('2000')
  })

  it('delivers pending orchestration messages to an already-idle agent', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)

      expect(write).toHaveBeenCalledWith('pty-1', expect.stringContaining('Subject: hello'))
      // Why: the split Enter write lands after the 500ms delay, so we advance
      // past it before asserting on delivered_at.
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith('pty-1', '\r')

      // Why: design doc §3.2 splits delivered vs. read — push-on-idle stamps
      // `delivered_at` but must *not* flip `read`, since only the check caller
      // (the agent) is authorized to consume messages from its queue. The
      // injected banner is a courtesy; the rows stay unread so the agent can
      // still observe them via `check` and resolve the consumption race.
      const unread = db.getUnreadMessages(terminal.handle)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).not.toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('injects pending orchestration messages into Cursor Agent without auto-submitting', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;\u280b Cursor Agent\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Cursor ready\x07', 101)
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello cursor' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)

      expect(write).toHaveBeenCalledWith('pty-1', expect.stringContaining('Subject: hello cursor'))
      await vi.advanceTimersByTimeAsync(500)
      const submitWrites = write.mock.calls.filter(
        ([ptyId, text]) => ptyId === 'pty-1' && text === '\r'
      )
      expect(submitWrites).toHaveLength(0)

      // Why: Cursor Agent treats injected PTY text as editable prompt input.
      // The user must submit it manually, but the banner should not replay on
      // the next idle transition.
      const unread = db.getUnreadMessages(terminal.handle)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).not.toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still auto-submits to a non-Cursor agent when its idle title mentions Cursor Agent', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime, 'pty-1', { tabTitle: 'cursor-repro-branch' })

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;. Investigate Cursor Agent\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;* Investigate Cursor Agent\x07', 101)
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello claude' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      expect(write).toHaveBeenCalledWith('pty-1', expect.stringContaining('Subject: hello claude'))
      expect(write).toHaveBeenCalledWith('pty-1', '\r')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not replay an already-delivered message on a later idle transition', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const db = new InMemoryOrchestrationMessages()
      const write = vi.fn().mockReturnValue(true)
      setInMemoryOrchestrationMessages(runtime, db)
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime)

      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
      db.insertMessage({ from: 'term_sender', to: terminal.handle, subject: 'hello' })

      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      const firstInjections = write.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].includes('Subject: hello')
      ).length
      expect(firstInjections).toBe(1)

      // Second idle transition: the row is still unread (no check caller has
      // consumed it), but it has been delivered. Push-on-idle must skip it to
      // avoid the replay bug.
      runtime.deliverPendingMessagesForHandle(terminal.handle)
      await vi.advanceTimersByTimeAsync(500)

      const totalInjections = write.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].includes('Subject: hello')
      ).length
      expect(totalInjections).toBe(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('adopts preallocated ORCA_TERMINAL_HANDLE as a valid runtime handle', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', 'ready\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.handle).toBe(handle)
    expect(read.tail).toEqual(['ready'])
  })

  it('binds advertised URLs for renderer-restored PTYs that skip registerPty', () => {
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime, 'pty-restored')
    runtime.onPtyData('pty-restored', 'Network: https://restored.example.com:3001/\n', 100)

    expect(advertisedUrlWatcher.lookup(TEST_WORKTREE_ID, 3001)?.origin).toBe(
      'https://restored.example.com:3001'
    )
  })

  it('keeps preallocated terminal handles valid across renderer reloads', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markRendererReloading(1)
    syncSinglePty(runtime, null)
    runtime.onPtyData('pty-1', 'after reload\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after reload'])
  })

  it('keeps preallocated terminal handles valid when a reload graph omits the live leaf', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markRendererReloading(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.onPtyData('pty-1', 'after omitted leaf\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after omitted leaf'])
  })

  it('keeps preallocated terminal handles valid after graph unavailable during reload', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markGraphUnavailable(1)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.onPtyData('pty-1', 'after unavailable\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after unavailable'])
  })

  it('keeps runtime-created PTY handles valid after graph unavailable', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.markGraphUnavailable(1)
    runtime.onPtyData('pty-bg', 'after unavailable\n', 100)

    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      handle,
      tail: ['after unavailable']
    })
    await expect(runtime.sendTerminal(handle, { text: 'still writable' })).resolves.toMatchObject({
      handle,
      accepted: true
    })
    expect(writes).toEqual(['still writable'])
  })

  it('recognizes runtime-created PTY handles with agent launch titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'Codex package-cache cleanup'
    })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('does not recognize runtime-created Claude agents management screens as agents', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('uses stale runtime-created PTY status when there is no title or foreground evidence', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastAgentStatus: 'working' | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastAgentStatus = 'working'
    runtime.setPtyController(null)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets Claude agents management titles clear stale runtime-created title status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastAgentStatus: 'working' | null
            lastOscTitle: string | null
            lastOscTitleAt: number | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastAgentStatus = 'working'
    pty.lastOscTitle = 'claude agents'
    pty.lastOscTitleAt = 0

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not recognize live Claude agents panes from a Claude foreground process', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('lets Claude agents pane titles override stale live-leaf title status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('lets Claude agents OSC titles override stale live-leaf pane titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('does not let stale tab-level Claude agents titles suppress current pane activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', {
      tabTitle: 'claude agents',
      paneTitle: 'claude working'
    })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
  })

  it('does not let stale tab-level agent titles override current neutral pane titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1', {
      tabTitle: 'claude working',
      paneTitle: 'bash'
    })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('does not let stale live-leaf status override current neutral pane titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('does not expose stale live-leaf agent status after Claude agents title supersedes it', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    const [terminal] = (await runtime.listTerminals()).terminals

    expect(runtime.getAgentStatusForHandle(terminal.handle)).toBeNull()
  })

  it('lists live terminals with fresh pane titles over stale tab titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude working',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'claude agents'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    expect(terminal.title).toBe('claude agents')
  })

  it('does not let stale Claude agents OSC titles suppress current pane activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
  })

  it('lets adopted pane Claude agents titles override stale PTY-handle activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude working\x07', 100)

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude agents' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('lets adopted neutral pane titles override stale PTY-handle activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude working\x07', 100)

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('lets adopted neutral pane titles use non-shell foreground fallback', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets adopted neutral pane titles retry wrapper foregrounds until recognized', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('codex')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('waits for delayed wrapper foreground cache enrichment', async () => {
    const getForegroundProcess = vi.fn(async () => (Date.now() >= 4_000 ? 'codex' : 'node'))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const result = runtime.isTerminalRunningAgent(handle)
      await vi.advanceTimersByTimeAsync(4_200)

      await expect(result).resolves.toBe(true)
      expect(getForegroundProcess.mock.calls.length).toBeGreaterThan(20)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recognize arbitrary foreground TUIs as running agents', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'vim'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not recognize unresolved wrapper foregrounds as running agents', async () => {
    const getForegroundProcess = vi.fn().mockResolvedValue('node')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    vi.useFakeTimers()
    try {
      const result = runtime.isTerminalRunningAgent(handle)
      await vi.advanceTimersByTimeAsync(7_000)

      await expect(result).resolves.toBe(false)
      expect(getForegroundProcess.mock.calls.length).toBeGreaterThan(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets live neutral pane titles retry wrapper foregrounds until recognized', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('codex')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('keeps Claude management titles suppressed after wrapper foreground refreshes', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('claude')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude agents' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('lets adopted Claude agents pane titles use non-Claude foreground fallback', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude agents' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('keeps ready prompt evidence when an adopted pane title is neutral', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'Codex working'
    })
    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })
    runtime.onPtyData(
      'pty-bg',
      ['OpenAI Codex', 'Model: gpt-5.4', 'Directory: /tmp/worktree-a'].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets adopted pane agent titles override stale PTY Claude agents titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude agents\x07', 100)

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude working' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets current Claude agents PTY titles override stale runtime-created OSC titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastOscTitle: string | null
            lastOscTitleAt: number | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastOscTitle = 'claude working'
    pty.lastOscTitleAt = 0

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not let stale Claude agents OSC titles suppress current PTY title activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'claude working'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastOscTitle: string | null
            lastOscTitleAt: number | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastOscTitle = 'claude agents'
    pty.lastOscTitleAt = 0

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes fresh runtime-created agent OSC titles over stale Claude agents launch titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude working\x07', 100)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('keeps Claude agents management evidence when controller refresh reports a Claude process title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude',
      listProcesses: async () => [{ id: 'pty-bg', cwd: TEST_WORKTREE_PATH, title: 'claude' }]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    await runtime.getWorktreePs()

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('allows non-Claude foreground agents after preserved Claude agents management evidence', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex',
      listProcesses: async () => [{ id: 'pty-bg', cwd: TEST_WORKTREE_PATH, title: 'zsh' }]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    await runtime.getWorktreePs()

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('does not let stale PTY status override a fresh neutral PTY title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'Claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;Claude working\x07', 100)
    runtime.onPtyData('pty-bg', '\x1b]0;zsh\x07', 101)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not use stale runtime-created PTY status when a neutral PTY title exists', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'zsh'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastAgentStatus: 'working' | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastAgentStatus = 'working'
    runtime.setPtyController(null)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('recognizes ready prompt evidence even with a stale Claude agents title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    runtime.onPtyData(
      'pty-bg',
      ['OpenAI Codex', 'Model: gpt-5.4', 'Directory: /tmp/worktree-a'].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes runtime-created Codex PTY handles from the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      ['OpenAI Codex', 'Model: gpt-5.4', 'Directory: /tmp/worktree-a'].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes runtime-created Antigravity PTY handles from the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData('pty-bg', antigravityReadyScreen(), 100)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes Antigravity ready tails with the prompt before the model line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData('pty-bg', antigravityPromptBeforeModelReadyScreen(), 100)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes live leaf Antigravity terminals from the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: null
        }
      ]
    })
    runtime.onPtyData('pty-1', antigravityReadyScreen(), 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
  })

  it('does not recognize partial Antigravity startup output as an agent', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        'Antigravity CLI 1.0.3',
        'user@example.com (Antigravity Business)',
        'Gemini 3.5 Flash (High)'
      ].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('rejects a later Antigravity header with a prompt but no model line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        antigravityReadyScreen(),
        '\nAntigravity CLI 1.0.4\n',
        'user@example.com (Antigravity Business)\n',
        '~/orca/workspaces/orca/agy-dispatch-issue\n',
        '>\n'
      ].join(''),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('uses the latest Antigravity header when checking readiness', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        antigravityReadyScreen(),
        '\nAntigravity CLI 1.0.4\n',
        'user@example.com (Antigravity Business)\n',
        'Gemini 4 Experimental (High)\n',
        'Do you trust this workspace directory?\n'
      ].join(''),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('recognizes Antigravity prompts written as the current partial line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'worker'
    })

    runtime.onPtyData(
      'pty-bg',
      [
        'Antigravity CLI 1.0.3\n',
        'user@example.com (Antigravity Business)\n',
        'Gemini 3.5 Flash (High)\n',
        '~/orca/workspaces/orca/agy-dispatch-issue\n'
      ].join(''),
      100
    )
    runtime.onPtyData('pty-bg', '   >   ', 101)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('does not classify agy workspace paths or titles without the ready prompt', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: '/tmp/agy-workspace',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: '/tmp/agy-workspace'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'cd /tmp/agy-workspace\n', 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('keeps mobile terminal surfaces visible while their leaf handle is pending', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('keeps mobile terminal surfaces pending while a live leaf has no PTY', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: null,
          paneTitle: 'Terminal 1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('omits stale browser session tabs that no longer have live webContents', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabList = vi.fn(() => ({
      tabs: [
        {
          browserPageId: 'browser-page-live',
          index: 0,
          url: 'https://live.example/',
          title: 'Live Browser',
          active: true
        }
      ]
    }))
    runtime.setAgentBrowserBridge({ tabList } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'browser-unified-stale',
          activeTabType: 'browser',
          tabs: [
            {
              type: 'browser',
              id: 'browser-unified-stale',
              title: 'Dead Browser',
              browserWorkspaceId: 'browser-workspace-stale',
              browserPageId: 'browser-page-stale',
              url: 'about:blank',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: true
            },
            {
              type: 'browser',
              id: 'browser-unified-live',
              title: 'Stale Title',
              browserWorkspaceId: 'browser-workspace-live',
              browserPageId: 'browser-page-live',
              url: 'https://stale.example/',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: false
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(tabList).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'browser',
        id: 'browser-unified-live',
        browserPageId: 'browser-page-live',
        url: 'https://live.example/',
        title: 'Live Browser',
        isActive: true
      })
    ])
    expect(result.activeTabId).toBe('browser-unified-live')
    expect(result.activeTabType).toBe('browser')
  })

  it('does not let the active browser webContents steal session focus from terminals', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabList = vi.fn(() => ({
      tabs: [
        {
          browserPageId: 'browser-page-1',
          index: 0,
          url: 'https://example.com/',
          title: 'Live Browser',
          active: true
        }
      ]
    }))
    runtime.setAgentBrowserBridge({ tabList } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'terminal-tab::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'browser',
              id: 'browser-unified-1',
              title: 'Stale Browser',
              browserWorkspaceId: 'browser-workspace-1',
              browserPageId: 'browser-page-1',
              url: 'https://stale.example/',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: false
            },
            {
              type: 'terminal',
              id: 'terminal-tab::pane:1',
              parentTabId: 'terminal-tab',
              leafId: 'pane:1',
              title: 'Terminal 2',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.activeTabId).toBe('terminal-tab::pane:1')
    expect(result.activeTabType).toBe('terminal')
    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'browser',
        id: 'browser-unified-1',
        isActive: false,
        title: 'Live Browser'
      }),
      expect.objectContaining({
        type: 'terminal',
        id: 'terminal-tab::pane:1',
        isActive: true
      })
    ])
  })

  it('publishes terminal surface agent status for paired web clients', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const hostPaneKey = `tab-1:${leafId}`
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'codex [working]',
              agentStatus: {
                state: 'working',
                prompt: 'fix parity',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'codex',
                paneKey: hostPaneKey,
                terminalTitle: 'codex [working]',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `tab-1::${leafId}`,
        status: 'pending-handle',
        terminal: null,
        agentStatus: expect.objectContaining({
          state: 'working',
          prompt: 'fix parity',
          agentType: 'codex',
          paneKey: hostPaneKey
        })
      })
    ])
  })

  it('keeps renderer-vetted mobile agent status for custom-titled terminals', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const hostPaneKey = `tab-1:${leafId}`
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'claude agents',
              agentStatus: {
                state: 'working',
                prompt: 'fix parity',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'codex',
                paneKey: hostPaneKey,
                terminalTitle: 'codex [working]',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents',
        agentStatus: expect.objectContaining({
          state: 'working',
          agentType: 'codex',
          paneKey: hostPaneKey
        })
      })
    )
  })

  it('suppresses saved mobile agent status when live evidence is the Claude agents screen', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'claude agents'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'claude agents',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `tab-1:${leafId}`,
                terminalTitle: 'claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents'
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('agentStatus')
  })

  it('suppresses saved mobile agent status when the current terminal title is neutral', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'bash'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'bash',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `tab-1:${leafId}`,
                terminalTitle: 'claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'bash'
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('agentStatus')
  })

  it('suppresses saved mobile agent status when fresh live OSC title is Claude agents', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'claude working'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'claude working',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `tab-1:${leafId}`,
                terminalTitle: 'claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents'
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('agentStatus')
  })

  it('keeps saved PTY bindings pending until the runtime knows the PTY is connected', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              ptyId: 'daemon-pty-1',
              parentLayout: {
                root: { type: 'leaf', leafId: 'pane:1' },
                activeLeafId: 'pane:1',
                expandedLeafId: null,
                ptyIdsByLeafId: { 'pane:1': 'daemon-pty-1' }
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        ptyId: 'daemon-pty-1',
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('refreshes daemon PTY liveness before publishing mobile session tabs', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'daemon-pty-1', cwd: TEST_WORKTREE_PATH, title: 'daemon shell' }
      ]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              ptyId: 'daemon-pty-1',
              parentLayout: {
                root: { type: 'leaf', leafId: 'pane:1' },
                activeLeafId: 'pane:1',
                expandedLeafId: null,
                ptyIdsByLeafId: { 'pane:1': 'daemon-pty-1' }
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        ptyId: 'daemon-pty-1',
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
    ])
  })

  it('reattaches mobile terminal surfaces from saved PTY bindings when the PTY is connected', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'daemon-pty-1'
        }
      ]
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              ptyId: 'daemon-pty-1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
    ])
    expect(runtime.resolveLeafForHandle((result.tabs[0] as { terminal: string }).terminal)).toEqual(
      { ptyId: 'daemon-pty-1' }
    )
  })

  it('does not publish exited saved PTY bindings as ready terminal streams', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              ptyId: 'daemon-pty-1',
              isActive: true
            }
          ]
        }
      ]
    })
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    runtime.onPtyExit('daemon-pty-1', 0)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'tab-1::pane:1',
        status: 'pending-handle',
        terminal: null
      })
    ])
  })

  it('resolves mobile terminal surfaces by exact split leaf', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:2',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'left'
        },
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:2',
          paneRuntimeId: 2,
          ptyId: 'pty-2',
          paneTitle: 'right'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:2',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: false
            },
            {
              type: 'terminal',
              id: 'tab-1::pane:2',
              parentTabId: 'tab-1',
              leafId: 'pane:2',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toHaveLength(2)
    expect(result.tabs).toEqual([
      expect.objectContaining({ id: 'tab-1::pane:1', title: 'left', status: 'ready' }),
      expect.objectContaining({ id: 'tab-1::pane:2', title: 'right', status: 'ready' })
    ])
    const [left, right] = result.tabs
    expect(left?.type).toBe('terminal')
    expect(right?.type).toBe('terminal')
    if (left?.type === 'terminal' && right?.type === 'terminal') {
      expect(left.terminal).not.toBe(right.terminal)
    }
  })

  it('keeps published mobile terminal handles usable across renderer graph epochs', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const tab = result.tabs[0]
    expect(tab?.type).toBe('terminal')
    if (tab?.type !== 'terminal' || tab.status !== 'ready') {
      throw new Error('expected ready terminal tab')
    }

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-2',
          snapshotVersion: 2,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('pty-1', 'after graph sync\n', 100)

    await expect(runtime.readTerminal(tab.terminal)).resolves.toMatchObject({
      handle: tab.terminal,
      tail: ['after graph sync']
    })
  })

  it('closes the matching mobile terminal UUID leaf without closing the whole tab', async () => {
    const closeTerminal = vi.fn()
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal,
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const leftLeafId = '11111111-1111-4111-8111-111111111111'
    const rightLeafId = '22222222-2222-4222-8222-222222222222'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: rightLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: leftLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-left',
          paneTitle: 'left'
        },
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: rightLeafId,
          paneRuntimeId: 2,
          ptyId: 'pty-right',
          paneTitle: 'right'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `tab-1::${rightLeafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${rightLeafId}`,
              parentTabId: 'tab-1',
              leafId: rightLeafId,
              title: 'right',
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, `tab-1::${rightLeafId}`)

    expect(kill).toHaveBeenCalledWith('pty-right')
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('closes the whole mobile terminal tab when addressed by parent tab id', async () => {
    const closeTerminal = vi.fn()
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal,
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Terminal 1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-1')

    expect(closeTerminal).toHaveBeenCalledWith('tab-1')
    expect(kill).not.toHaveBeenCalled()
  })

  it('activates the active split leaf when addressed by parent tab id', async () => {
    const focusTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal,
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'tab-1::pane:2',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'left',
              isActive: false
            },
            {
              type: 'terminal',
              id: 'tab-1::pane:2',
              parentTabId: 'tab-1',
              leafId: 'pane:2',
              title: 'right',
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-1')

    expect(focusTerminal).toHaveBeenCalledWith('tab-1', TEST_WORKTREE_ID, 'pane:2')
  })

  it('closes browser mobile session tabs when addressed by browser workspace id', async () => {
    const closeSessionTab = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab,
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'browser-unified-1',
          activeTabType: 'browser',
          tabs: [
            {
              type: 'browser',
              id: 'browser-unified-1',
              title: 'Browser',
              browserWorkspaceId: 'browser-workspace-1',
              browserPageId: 'browser-page-1',
              url: 'https://example.com/',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'browser-workspace-1')

    expect(closeSessionTab).toHaveBeenCalledWith('browser-unified-1', TEST_WORKTREE_ID)
  })

  it('creates mobile session terminals in a headless runtime server', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-headless' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`)

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        tabId: expect.stringMatching(UUID_RE),
        leafId: expect.stringMatching(UUID_RE),
        persistHostSessionBinding: true,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    expect(result.tab).toMatchObject({
      type: 'terminal',
      status: 'ready',
      terminal: expect.stringMatching(/^term_/),
      isActive: true
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        id: result.tab.id,
        status: 'ready',
        terminal: result.tab.terminal
      })
    ])
  })

  it('spawns fresh headless SSH mobile session terminals instead of reattaching synthetic local ids', async () => {
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'ssh:ssh-1@@remote-pty' })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`)

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        worktreeId: TEST_WORKTREE_ID,
        persistHostSessionBinding: true
      })
    )
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
  })

  it('hydrates headless mobile session terminals from the host workspace session', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'persisted-pty',
        status: 'pending-handle',
        terminal: null,
        isActive: true
      })
    ])
    expect(listed.tabGroups?.[0]).toMatchObject({
      activeTabId: 'host-tab',
      tabOrder: ['host-tab']
    })
  })

  it('keeps live headless mobile session terminals when a desktop renderer publishes without them', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'serve-mobile-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`)

    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: created.tab.id,
        parentTabId: created.tab.parentTabId,
        leafId: created.tab.leafId,
        ptyId: 'serve-mobile-pty',
        status: 'ready'
      })
    ])
  })

  it('publishes laptop-created remote runtime terminals to phone session tabs', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      command: "claude 'work on the issue'",
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Codex working\x07', Date.now())
    runtime.onPtyData('laptop-created-pty', 'Claude is working...\r\n', Date.now())

    const phoneTabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(laptopTerminal.surface).toBe('background')
    expect(phoneTabs.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'laptop-tab',
        leafId: HEADLESS_LEAF_ID,
        status: 'ready',
        terminal: laptopTerminal.handle,
        agentStatus: expect.objectContaining({
          state: 'working',
          paneKey: `laptop-tab:${HEADLESS_LEAF_ID}`,
          terminalHandle: laptopTerminal.handle
        })
      })
    ])
    await expect(runtime.readTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      tail: ['Claude is working...']
    })
  })

  it('replaces pending phone session tabs when a laptop-created remote PTY becomes live', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-pending',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `laptop-tab::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabGroups: [{ id: 'group-1', activeTabId: 'laptop-tab', tabOrder: ['laptop-tab'] }],
          tabs: [
            {
              type: 'terminal',
              id: `laptop-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'laptop-tab',
              leafId: HEADLESS_LEAF_ID,
              title: 'Starting Claude',
              isActive: true
            }
          ]
        }
      ]
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })

    const phoneTabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(phoneTabs.tabs).toHaveLength(1)
    expect(phoneTabs.tabs[0]).toMatchObject({
      type: 'terminal',
      id: `laptop-tab::${HEADLESS_LEAF_ID}`,
      status: 'ready',
      terminal: laptopTerminal.handle
    })
  })

  it('publishes laptop-created remote runtime split terminals to phone session tabs', async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'laptop-created-pty' })
      .mockResolvedValueOnce({ id: 'laptop-split-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    const split = await runtime.splitTerminal(laptopTerminal.handle, {
      direction: 'vertical'
    })

    const phoneTabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminalTabs = phoneTabs.tabs.filter((tab) => tab.type === 'terminal')

    expect(split.tabId).toBe('laptop-tab')
    expect(terminalTabs).toHaveLength(2)
    expect(terminalTabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentTabId: 'laptop-tab',
          leafId: HEADLESS_LEAF_ID,
          status: 'ready',
          terminal: laptopTerminal.handle
        }),
        expect.objectContaining({
          parentTabId: 'laptop-tab',
          status: 'ready',
          terminal: split.handle
        })
      ])
    )
  })

  it('pushes PTY-backed mobile session tab title and agent status changes to subscribers', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude waiting for permission\x07', 124)

    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            title: 'Claude working',
            agentStatus: expect.objectContaining({
              state: 'working',
              terminalHandle: laptopTerminal.handle
            })
          })
        ]
      }),
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            agentStatus: expect.objectContaining({
              state: 'blocked',
              terminalHandle: laptopTerminal.handle
            })
          })
        ]
      })
    ])
    expect(events[1]!.snapshotVersion).toBeGreaterThan(events[0]!.snapshotVersion)

    unsubscribe()
  })

  it('does not publish stale PTY-backed mobile agent status for Claude agents screens', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.onPtyData('laptop-created-pty', '\x1b]0;claude agents\x07', 124)

    expect(events[0]?.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({ state: 'working' })
      })
    )
    expect(events[1]?.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents'
      })
    )
    expect(events[1]?.tabs[0]).not.toHaveProperty('agentStatus')

    unsubscribe()
  })

  it('uses fresh PTY management titles over stale mobile snapshot and OSC titles', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const leafId = HEADLESS_LEAF_ID
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'laptop-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-stale',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `laptop-tab::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `laptop-tab::${leafId}`,
              parentTabId: 'laptop-tab',
              leafId,
              title: 'Claude working',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `laptop-tab:${leafId}`,
                terminalTitle: 'Claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;claude agents\x07', 124)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents'
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('agentStatus')
  })

  it('uses fresh neutral PTY titles over stale mobile snapshot and OSC titles', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = HEADLESS_LEAF_ID
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'laptop-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-stale',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `laptop-tab::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `laptop-tab::${leafId}`,
              parentTabId: 'laptop-tab',
              leafId,
              title: 'Claude working',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `laptop-tab:${leafId}`,
                terminalTitle: 'Claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;zsh\x07', 124)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'zsh'
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('agentStatus')
  })

  it('pushes PTY-backed mobile session readiness changes when a server PTY exits', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyExit('laptop-created-pty', 0)

    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            parentTabId: 'laptop-tab',
            status: 'pending-handle',
            terminal: null
          })
        ]
      })
    ])
    await expect(runtime.readTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('operates PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })

    await expect(runtime.renameTerminal(laptopTerminal.handle, 'Shared Claude')).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      title: 'Shared Claude'
    })
    await expect(runtime.focusTerminal(laptopTerminal.handle)).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      worktreeId: TEST_WORKTREE_ID
    })
    await expect(runtime.closeTerminal(laptopTerminal.handle)).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      ptyKilled: true
    })
    expect(kill).toHaveBeenCalledWith('laptop-created-pty')
  })

  it('lists PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07hello\r\n', 123)

    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [
        expect.objectContaining({
          handle: laptopTerminal.handle,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          connected: true,
          preview: 'hello'
        })
      ],
      totalCount: 1,
      truncated: false
    })
  })

  it('shows and resolves active PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07hello\r\n', 123)

    await expect(runtime.resolveActiveTerminal(`id:${TEST_WORKTREE_ID}`)).resolves.toBe(
      laptopTerminal.handle
    )
    await expect(runtime.showTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID,
      worktreeId: TEST_WORKTREE_ID,
      title: 'Claude working',
      connected: true,
      ptyId: 'laptop-created-pty'
    })
  })

  it('keeps split sibling headless mobile terminal leaves when a desktop renderer omits them', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:split-siblings',
          snapshotVersion: 1,
          activeGroupId: 'headless-group',
          activeTabId: 'host-tab::pane:2',
          activeTabType: 'terminal',
          tabGroups: [
            {
              id: 'headless-group',
              activeTabId: 'host-tab',
              tabOrder: ['host-tab']
            }
          ],
          tabs: [
            {
              type: 'terminal',
              id: 'host-tab::pane:1',
              parentTabId: 'host-tab',
              leafId: 'pane:1',
              title: 'left',
              isActive: false
            },
            {
              type: 'terminal',
              id: 'host-tab::pane:2',
              parentTabId: 'host-tab',
              leafId: 'pane:2',
              title: 'right',
              isActive: true
            }
          ]
        }
      ]
    })

    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty',
          snapshotVersion: 2,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: 'host-tab::pane:1',
        parentTabId: 'host-tab',
        leafId: 'pane:1'
      }),
      expect.objectContaining({
        type: 'terminal',
        id: 'host-tab::pane:2',
        parentTabId: 'host-tab',
        leafId: 'pane:2'
      })
    ])
    expect(listed.activeTabId).toBe('host-tab::pane:2')
  })

  it('keeps preserved headless mobile session publication epochs idempotent', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:stable-epoch',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: 'host-tab::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'host-tab::pane:1',
              parentTabId: 'host-tab',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: true
            }
          ]
        }
      ]
    })

    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const firstMerge = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const secondMerge = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(secondMerge.publicationEpoch).toBe(firstMerge.publicationEpoch)
    expect(secondMerge.publicationEpoch.match(/:headless-merge:/g) ?? []).toHaveLength(1)
  })

  it('hydrates persisted serve-owned mobile session terminals while a renderer is attached', async () => {
    const focusTerminal = vi.fn()
    const spawn = vi.fn().mockResolvedValue({ id: 'serve-persisted-pty', isReattach: true })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'serve-persisted-pty',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Mobile Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-persisted-pty' })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal,
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'serve-persisted-pty',
        status: 'pending-handle'
      })
    ])
    expect(listed.tabGroups?.[0]).toMatchObject({
      activeTabId: 'host-tab',
      tabOrder: ['host-tab']
    })

    const activated = await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: 'serve-persisted-pty',
        persistHostSessionBinding: true,
        worktreeId: TEST_WORKTREE_ID
      })
    )
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready'
    })
  })

  it('hydrates legacy persisted terminal tabs without layout entries', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        terminalLayoutsByTabId: {}
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminal = listed.tabs[0]

    expect(terminal).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      ptyId: 'persisted-pty',
      status: 'pending-handle'
    })
    expect(terminal?.id).toMatch(/^host-tab::[0-9a-f-]{36}$/)
  })

  it('does not mark persisted PTY id collisions ready without matching pane identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'Unrelated PTY' }
      ]
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'pending-handle',
      terminal: null
    })
  })

  it('kills persisted SSH PTYs when closing hydrated headless tabs before pane metadata is restored', async () => {
    const persistedPtyId = 'ssh:ssh-1@@relay-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: persistedPtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: persistedPtyId })
        }
      })
    )
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: persistedPtyId, cwd: TEST_WORKTREE_PATH, title: 'Remote' }]
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(kill).toHaveBeenCalledWith(persistedPtyId)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('materializes hydrated pending headless terminals with the persisted session identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const spawn = vi.fn().mockResolvedValue({ id: 'persisted-pty' })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const activated = await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: 'persisted-pty',
        persistHostSessionBinding: true,
        worktreeId: TEST_WORKTREE_ID
      })
    )
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
  })

  it('reattaches hydrated SSH headless terminals with the persisted relay identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'ssh:ssh-1@@relay-pty',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({
            [HEADLESS_LEAF_ID]: 'ssh:ssh-1@@relay-pty'
          })
        }
      })
    )
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'ssh:ssh-1@@relay-pty', isReattach: true })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: 'ssh:ssh-1@@relay-pty',
        persistHostSessionBinding: true
      })
    )
  })

  it('spawns fresh after an expired hydrated SSH headless reattach clears persistence', async () => {
    const stalePtyId = 'ssh:ssh-1@@relay-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: stalePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: stalePtyId })
        }
      })
    )
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi
      .fn()
      .mockImplementationOnce(async () => {
        const session = getSession()
        ;(runtimeStore.setWorkspaceSession as unknown as (next: WorkspaceSessionState) => void)({
          ...session,
          tabsByWorktree: {
            ...session.tabsByWorktree,
            [TEST_WORKTREE_ID]: session.tabsByWorktree[TEST_WORKTREE_ID].map((tab) =>
              tab.id === 'host-tab' ? { ...tab, ptyId: null } : tab
            )
          },
          terminalLayoutsByTabId: {
            ...session.terminalLayoutsByTabId,
            'host-tab': {
              ...session.terminalLayoutsByTabId['host-tab'],
              ptyIdsByLeafId: {}
            }
          }
        })
        throw new Error('SSH session expired')
      })
      .mockResolvedValueOnce({ id: 'ssh:ssh-1@@fresh-pty' })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')
    ).rejects.toThrow('SSH session expired')
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connectionId: 'ssh-1',
        sessionId: stalePtyId
      })
    )
    expect(spawn.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        connectionId: 'ssh-1',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        persistHostSessionBinding: true
      })
    )
    expect(spawn.mock.calls[1]?.[0]).not.toHaveProperty('sessionId')
  })

  it('keeps the activated headless tab active across PTY republishes (serve focus-jump regression)', async () => {
    // Why: in `orca serve`, focusTerminal has no renderer to persist the remote
    // client's tab choice before PTY republishes.
    let nextPty = 0
    const spawn = vi.fn().mockImplementation(async () => ({ id: `headless-pty-${++nextPty}` }))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const FIRST_LEAF = '22222222-2222-4222-8222-222222222222'
    const SECOND_LEAF = '33333333-3333-4333-8333-333333333333'
    // The first-created headless terminal is the one the snapshot marks active.
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'tab-first',
      leafId: FIRST_LEAF
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'tab-other',
      leafId: SECOND_LEAF
    })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    // The remote client switches to the other (non-active) tab.
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-other')

    const afterActivate = events.at(-1)
    expect(afterActivate?.activeTabId).toBe(`tab-other::${SECOND_LEAF}`)
    expect(afterActivate?.activeTabType).toBe('terminal')
    expect(afterActivate?.tabGroups?.[0]?.activeTabId).toBe('tab-other')
    expect(
      afterActivate?.tabs.find((tab) => tab.id === `tab-other::${SECOND_LEAF}`)?.isActive
    ).toBe(true)
    expect(afterActivate?.tabs.find((tab) => tab.id === `tab-first::${FIRST_LEAF}`)?.isActive).toBe(
      false
    )

    // PTY title updates republish snapshots, so the client's chosen tab must
    // survive after activation.
    events.length = 0
    runtime.onPtyData('headless-pty-2', '\x1b]0;tab-other running\x07', 200)

    const afterPtyData = events.at(-1)
    expect(afterPtyData?.activeTabId).toBe(`tab-other::${SECOND_LEAF}`)
    expect(afterPtyData?.activeTabType).toBe('terminal')
    expect(afterPtyData?.tabGroups?.[0]?.activeTabId).toBe('tab-other')
  })

  it('does not bump the snapshot version when re-activating the already-active headless tab', async () => {
    // Why: redundant activations of the current tab must not force a remote re-render.
    const spawn = vi.fn().mockResolvedValue({ id: 'headless-pty-solo' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const LEAF = '44444444-4444-4444-8444-444444444444'
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-solo', leafId: LEAF })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-solo')

    expect(events).toHaveLength(0)
  })

  it('does not persist active server-side when an authoritative renderer is attached', async () => {
    // Why: when a renderer window is authoritative it re-syncs the snapshot itself,
    // so the headless persist must NOT fire — the renderer stays the source of truth.
    let nextPty = 0
    const spawn = vi.fn().mockImplementation(async () => ({ id: `attached-pty-${++nextPty}` }))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const LEAF_A = '55555555-5555-4555-8555-555555555555'
    const LEAF_B = '66666666-6666-4666-8666-666666666666'
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-a', leafId: LEAF_A })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-b', leafId: LEAF_B })

    // Make an authoritative renderer window present.
    runtime.attachWindow(1)
    runtime.markGraphReady(1)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-b')

    // The headless persist is gated off by the authoritative window — nothing emitted.
    expect(events).toHaveLength(0)
  })

  it('does not persist active server-side for a `:headless-merge:` snapshot after renderer detach', async () => {
    // Why: after renderer detach, merged snapshots have no authoritative window
    // but still carry renderer-owned group state.
    let nextPty = 0
    const spawn = vi.fn().mockImplementation(async () => ({ id: `merge-pty-${++nextPty}` }))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const LEAF_A = '77777777-7777-4777-8777-777777777777'
    const LEAF_B = '88888888-8888-4888-8888-888888888888'
    // tab-a (first-created) is the snapshot's active tab.
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-a', leafId: LEAF_A })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-b', leafId: LEAF_B })

    // Simulate a post-detach merged snapshot with no authoritative window.
    const current = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!
    runtime['mobileSessionTabsByWorktree'].set(TEST_WORKTREE_ID, {
      ...current,
      publicationEpoch: `renderer:headless-merge:${current.publicationEpoch}`
    })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    // The merge exclusion must suppress server-side active rewrites.
    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-b')

    expect(events).toHaveLength(0)
  })

  it('spawns fresh SSH terminals when hydrated persistence has no relay identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
        }
      })
    )
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const remoteStore = {
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'ssh:ssh-1@@fresh-pty' })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        persistHostSessionBinding: true
      })
    )
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
  })

  it('materializes the requested hydrated split leaf instead of the first sibling', async () => {
    const layout = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: 'pty-a',
      [HEADLESS_SECOND_LEAF_ID]: 'pty-b'
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'pty-a',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Split Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: { 'host-tab': layout }
      })
    )
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-b' })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_SECOND_LEAF_ID
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_SECOND_LEAF_ID,
        sessionId: 'pty-b'
      })
    )
    expect(activated.tabs).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'host-tab',
        leafId: HEADLESS_SECOND_LEAF_ID,
        status: 'ready'
      })
    )
  })

  it('rejects missing requested split leaves instead of activating a sibling', async () => {
    const layout = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: 'pty-a'
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        terminalLayoutsByTabId: { 'host-tab': layout }
      })
    )
    const spawn = vi.fn().mockResolvedValue({ id: 'unexpected-pty' })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.activateMobileSessionTab(
        `id:${TEST_WORKTREE_ID}`,
        'host-tab',
        HEADLESS_SECOND_LEAF_ID
      )
    ).rejects.toThrow('tab_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('closes persisted headless terminal parents and kills every live leaf', async () => {
    const layout = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: 'pty-a',
      [HEADLESS_SECOND_LEAF_ID]: 'pty-b'
    })
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'pty-a',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: { 'host-tab': layout }
      })
    )
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Persisted Terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'pty-a',
          paneTitle: 'A'
        },
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_SECOND_LEAF_ID,
          paneRuntimeId: 2,
          ptyId: 'pty-b',
          paneTitle: 'B'
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(kill).toHaveBeenCalledWith('pty-a')
    expect(kill).toHaveBeenCalledWith('pty-b')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('closes persisted headless terminal parents before any prior list call', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('builds mobile session agent launch commands on the runtime host', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { 'command-code': 'command-code --profile mobile' }
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'command-code'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "command-code --profile mobile '--yolo'",
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('publishes headless mobile session agent identity with synthesized PTY status', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'claude'
    })
    runtime.onPtyData('pty-agent', '\x1b]0;✳ Claude Code\x07', Date.now())

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(created.tab).toMatchObject({
      type: 'terminal',
      launchAgent: 'claude'
    })
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'claude'
        })
      })
    ])
  })

  it('rejects disabled mobile session agent launches before spawning', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex'],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex'
      })
    ).rejects.toThrow('Selected agent is disabled')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('validates mobile terminal insertion anchors before resolving agent launch commands', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex'],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        afterTabId: 'stale-tab',
        agent: 'codex'
      })
    ).rejects.toThrow('after_tab_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('forwards inactive mobile terminal creation to the renderer without focusing it', async () => {
    const focusTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      focusTerminal,
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const send = vi.fn((_channel: string, payload: { requestId: string; activate?: boolean }) => {
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'terminal',
                id: 'tab-renderer::pane:1',
                parentTabId: 'tab-renderer',
                leafId: 'pane:1',
                title: 'Terminal',
                isActive: false
              }
            ]
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        {},
        {
          requestId: payload.requestId,
          tabId: 'tab-renderer',
          title: 'Terminal'
        }
      )
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send }
    })

    const result = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false
    })

    expect(send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        activate: false
      })
    )
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(result.tab).toMatchObject({ parentTabId: 'tab-renderer', isActive: false })
  })

  it('reports browser tab creation as unsupported for headless runtime servers', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.browserTabCreate({ worktree: `id:${TEST_WORKTREE_ID}`, url: 'https://example.com' })
    ).rejects.toMatchObject({
      code: 'browser_error',
      message: expect.stringContaining('headless orca serve')
    })
  })

  it('cancels an in-flight same-connection browser screencast before replacing it', async () => {
    const runtime = createRuntime()
    const firstStart = deferred<{
      subscriptionId: string
      ready: never
      session: { stop: () => void; done: Promise<void> }
    }>()
    const firstDone = deferred<void>()
    const secondDone = deferred<void>()
    const thirdDone = deferred<void>()
    const firstStop = vi.fn(() => firstDone.resolve())
    const secondStop = vi.fn(() => secondDone.resolve())
    const thirdStop = vi.fn(() => thirdDone.resolve())
    const browserScreencast = vi
      .fn()
      .mockImplementationOnce(() => firstStart.promise)
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:second',
        ready: {
          type: 'ready',
          subscriptionId: 'browser-screencast:page-1:second',
          browserPageId: 'page-1',
          format: 'jpeg',
          tab: {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        },
        session: { stop: secondStop, done: secondDone.promise }
      })
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:third',
        ready: {
          type: 'ready',
          subscriptionId: 'browser-screencast:page-1:third',
          browserPageId: 'page-1',
          format: 'jpeg',
          tab: {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        },
        session: { stop: thirdStop, done: thirdDone.promise }
      })

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const firstEmit = vi.fn()
    const secondEmit = vi.fn()
    const first = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: firstEmit }
    )
    await Promise.resolve()

    const second = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: secondEmit }
    )
    const thirdEmit = vi.fn()
    const third = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: thirdEmit }
    )
    await Promise.resolve()

    expect(browserScreencast).toHaveBeenCalledTimes(1)

    firstStart.resolve({
      subscriptionId: 'browser-screencast:page-1:first',
      ready: {} as never,
      session: { stop: firstStop, done: firstDone.promise }
    })
    await first
    await Promise.resolve()

    expect(firstStop).toHaveBeenCalledTimes(1)
    expect(firstEmit).not.toHaveBeenCalled()
    expect(browserScreencast).toHaveBeenCalledTimes(2)

    await second
    await Promise.resolve()

    expect(secondStop).toHaveBeenCalledTimes(1)
    expect(browserScreencast).toHaveBeenCalledTimes(3)
    expect(thirdEmit).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:third' })
    )

    runtime.cleanupSubscription('browser-screencast:page-1:third')
    await third

    expect(thirdStop).toHaveBeenCalledTimes(1)
  })

  it('cancels an active same-page browser screencast before another connection starts', async () => {
    const runtime = createRuntime()
    const firstDone = deferred<void>()
    const secondDone = deferred<void>()
    const firstStop = vi.fn(() => firstDone.resolve())
    const secondStop = vi.fn(() => secondDone.resolve())
    const browserScreencast = vi
      .fn()
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:first',
        ready: {
          type: 'ready',
          subscriptionId: 'browser-screencast:page-1:first',
          browserPageId: 'page-1',
          format: 'jpeg',
          tab: {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        },
        session: { stop: firstStop, done: firstDone.promise }
      })
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:second',
        ready: {
          type: 'ready',
          subscriptionId: 'browser-screencast:page-1:second',
          browserPageId: 'page-1',
          format: 'jpeg',
          tab: {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        },
        session: { stop: secondStop, done: secondDone.promise }
      })

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const firstEmit = vi.fn()
    const first = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: firstEmit }
    )
    await vi.waitFor(() =>
      expect(firstEmit).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:first' })
      )
    )

    const secondEmit = vi.fn()
    const second = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-2', sendBinary: vi.fn(), emit: secondEmit }
    )

    await vi.waitFor(() => expect(firstStop).toHaveBeenCalledTimes(1))
    await first
    await vi.waitFor(() =>
      expect(secondEmit).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:second' })
      )
    )
    expect(browserScreencast).toHaveBeenCalledTimes(2)

    runtime.cleanupSubscription('browser-screencast:page-1:second')
    await second
    expect(secondStop).toHaveBeenCalledTimes(1)
  })

  it('does not deliver or accept browser screencast frames before ready', async () => {
    const runtime = createRuntime()
    const done = deferred<void>()
    const stop = vi.fn(() => done.resolve())
    const startupFrame = new Uint8Array([1, 2, 3])
    const sendBinary = vi.fn()
    const emit = vi.fn()
    const browserScreencast = vi.fn(
      async (_params: unknown, stream: { sendBinary: typeof sendBinary }) => {
        expect(stream.sendBinary(startupFrame)).toBe(false)
        expect(sendBinary).not.toHaveBeenCalled()
        return {
          subscriptionId: 'browser-screencast:page-1:first',
          ready: {
            type: 'ready',
            subscriptionId: 'browser-screencast:page-1:first',
            browserPageId: 'page-1',
            format: 'jpeg',
            tab: {
              browserPageId: 'page-1',
              index: 0,
              url: 'about:blank',
              title: 'Browser',
              active: true
            }
          },
          session: { stop, done: done.promise }
        }
      }
    )

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const task = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary, emit }
    )

    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
    )
    expect(sendBinary).not.toHaveBeenCalled()

    runtime.cleanupSubscription('browser-screencast:page-1:first')
    await task
  })

  it('keeps already-idle status after tui-idle wait for immediate message delivery', async () => {
    const runtime = new OrcaRuntimeService(store)
    const db = new InMemoryOrchestrationMessages()
    const write = vi.fn().mockReturnValue(true)
    setInMemoryOrchestrationMessages(runtime, db)
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)
    await runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle' })
    db.insertMessage({ from: 'sender', to: terminal.handle, subject: 'after wait' })

    runtime.deliverPendingMessagesForHandle(terminal.handle)

    expect(write).toHaveBeenCalledWith('pty-1', expect.stringContaining('Subject: after wait'))
    db.close()
  })

  it('resolves message waiters when notifyMessageArrived is called', async () => {
    const runtime = new OrcaRuntimeService(store)

    const waitPromise = runtime.waitForMessage('term_abc', { timeoutMs: 5000 })
    runtime.notifyMessageArrived('term_abc')
    await waitPromise
  })

  it('does not resolve type-filtered message waiters for unrelated message types', async () => {
    const runtime = new OrcaRuntimeService(store)

    const waitPromise = runtime.waitForMessage('term_abc', {
      typeFilter: ['worker_done', 'escalation'],
      timeoutMs: 5000
    })
    let settled = false
    void waitPromise.then(() => {
      settled = true
    })

    runtime.notifyMessageArrived('term_abc', 'heartbeat')
    await Promise.resolve()

    expect(settled).toBe(false)

    runtime.notifyMessageArrived('term_abc', 'worker_done')
    await waitPromise
    expect(settled).toBe(true)
  })

  it('removes message waiter abort listeners after message arrival', async () => {
    const runtime = new OrcaRuntimeService(store)
    const controller = new AbortController()
    const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')

    const waitPromise = runtime.waitForMessage('term_abc', {
      timeoutMs: 5000,
      signal: controller.signal
    })
    runtime.notifyMessageArrived('term_abc')
    await waitPromise

    expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('resolves message waiters on timeout when no message arrives', async () => {
    const runtime = new OrcaRuntimeService(store)

    const start = Date.now()
    await runtime.waitForMessage('term_abc', { timeoutMs: 100 })
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(500)
  })

  it('rejects leaf PTY waits when the request signal aborts', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const controller = new AbortController()

      const waitPromise = runtime
        .waitForLeafPtyId('missing-handle', 60_000, controller.signal)
        .then(() => 'resolved')
        .catch((error: Error) => error.message)

      controller.abort()
      const outcomePromise = Promise.race([
        waitPromise,
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
      ])
      await vi.advanceTimersByTimeAsync(0)

      expect(await outcomePromise).toBe('request_aborted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails terminal waits closed when the handle goes stale during reload', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, { timeoutMs: 1000 })
    runtime.markRendererReloading(1)

    await expect(waitPromise).rejects.toThrow('terminal_handle_stale')
  })

  it('tui-idle times out when PTY data has no agent OSC title transitions', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)

      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            title: 'Terminal 1',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-1'
          }
        ]
      })
      runtime.onPtyData('pty-1', 'running migration step 4/9\n', 123)

      const [terminal] = (await runtime.listTerminals()).terminals
      const waitPromise = runtime.waitForTerminal(terminal.handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(12_000)

      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('tui-idle resolves on agent working→idle OSC title transition', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    // Simulate agent starting work (braille spinner = working)
    runtime.onPtyData('pty-1', '\x1b]0;\u280b Working on task\x07output\n', 100)

    const [terminal] = (await runtime.listTerminals()).terminals
    const waitPromise = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })

    // Simulate agent finishing (✳ = Claude Code idle)
    runtime.onPtyData('pty-1', '\x1b]0;\u2733 Task complete\x07done\n', 200)

    const result = await waitPromise
    expect(result.condition).toBe('tui-idle')
    expect(result.satisfied).toBe(true)
  })

  it('builds a compact worktree summary from persisted and live runtime state', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'build green\n', 321)

    const summaries = await runtime.getWorktreePs()
    expect(summaries).toEqual({
      worktrees: [
        {
          worktreeId: 'repo-1::/tmp/worktree-a',
          repoId: 'repo-1',
          repo: 'repo',
          path: '/tmp/worktree-a',
          branch: 'feature/foo',
          parentWorktreeId: null,
          childWorktreeIds: [],
          displayName: 'foo',
          linkedIssue: 123,
          linkedPR: null,
          isPinned: false,
          status: 'active',
          unread: false,
          liveTerminalCount: 1,
          hasAttachedPty: true,
          lastOutputAt: 321,
          preview: 'build green'
        }
      ],
      totalCount: 1,
      truncated: false
    })
  })

  it('includes SSH-backed worktrees in the mobile worktree summary', async () => {
    const remoteRepo = {
      id: 'repo-ssh',
      path: '/home/me/project',
      displayName: 'remote-vm',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteWorktree = {
      path: '/home/me/project/.worktrees/feature-mobile',
      head: 'def',
      branch: 'refs/heads/feature/mobile',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {
      [`${remoteRepo.id}::${remoteWorktree.path}`]: makeWorktreeMeta({
        displayName: 'Remote mobile'
      })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    registerSshGitProvider('ssh-1', {
      listWorktrees: vi.fn().mockResolvedValue([remoteWorktree])
    } as never)

    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const summaries = await runtime.getWorktreePs()

    expect(summaries.worktrees).toEqual([
      expect.objectContaining({
        worktreeId: `${remoteRepo.id}::${remoteWorktree.path}`,
        repoId: remoteRepo.id,
        repo: 'remote-vm',
        path: remoteWorktree.path,
        displayName: 'Remote mobile'
      })
    ])
  })

  it('clears stale working status after the agent exits and the shell takes over the title', async () => {
    // Why: regression test for issue #1437 — the mobile worktree-list spinner
    // kept playing forever because lastAgentStatus was sticky on 'working'
    // once an agent exited without emitting an idle/agent-shaped final OSC
    // title. worktree.ps must recompute from the live OSC title each call.
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Codex working',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const working = await runtime.getWorktreePs()
    expect(working.worktrees[0].status).toBe('working')

    // Agent exits, shell title takes over — desktop's getWorktreeStatus would
    // immediately flip back to 'active'. Mobile must do the same.
    runtime.onPtyData('pty-1', '\x1b]0;bash\x07', 200)
    const afterExit = await runtime.getWorktreePs()
    expect(afterExit.worktrees[0].status).toBe('active')
  })

  it('shows worktree.ps active when the current pane is the Claude agents screen', async () => {
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })

    const summary = await runtime.getWorktreePs()

    expect(summary.worktrees[0].status).toBe('active')
  })

  it('shows worktree.ps working when the current pane supersedes a Claude agents OSC title', async () => {
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })

    const summary = await runtime.getWorktreePs()

    expect(summary.worktrees[0].status).toBe('working')
  })

  it('fails terminal stop closed while the renderer graph is reloading', async () => {
    const runtime = new OrcaRuntimeService(store)
    let killed = false
    runtime.setPtyController({
      write: () => true,
      kill: () => {
        killed = true
        return true
      },
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.markRendererReloading(1)

    await expect(runtime.stopTerminalsForWorktree('id:repo-1::/tmp/worktree-a')).rejects.toThrow(
      'runtime_unavailable'
    )
    expect(killed).toBe(false)
  })

  it('fails terminal listing closed if the graph reloads during selector resolution', async () => {
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    let releaseListWorktrees = () => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
        })
    )

    const listPromise = runtime.listTerminals('branch:feature/foo')
    runtime.markRendererReloading(1)
    releaseListWorktrees()

    await expect(listPromise).rejects.toThrow('runtime_unavailable')
  })

  it('fails terminal stop closed if the graph reloads during selector resolution', async () => {
    const runtime = new OrcaRuntimeService(store)
    let killed = false
    runtime.setPtyController({
      write: () => true,
      kill: () => {
        killed = true
        return true
      },
      getForegroundProcess: async () => null
    })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    let releaseListWorktrees = () => {}
    vi.mocked(listWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseListWorktrees = () => resolve(MOCK_GIT_WORKTREES)
        })
    )

    const stopPromise = runtime.stopTerminalsForWorktree('branch:feature/foo')
    runtime.markRendererReloading(1)
    releaseListWorktrees()

    await expect(stopPromise).rejects.toThrow('runtime_unavailable')
    expect(killed).toBe(false)
  })

  it('rejects invalid positive limits for bounded list commands', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.getWorktreePs(-1)).rejects.toThrow('invalid_limit')
    await expect(runtime.listManagedWorktrees(undefined, 0)).rejects.toThrow('invalid_limit')
    await expect(runtime.searchRepoRefs('id:repo-1', 'main', -5)).rejects.toThrow('invalid_limit')
  })

  it('returns capped SSH refs for empty runtime repo searches', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: () => remoteRepo
    }
    const provider = {
      exec: vi.fn().mockImplementation((argv: string[]) => {
        if (argv[0] === 'remote') {
          return Promise.resolve({ stdout: 'origin\nupstream\n', stderr: '' })
        }
        return Promise.resolve({
          stdout: [
            'refs/remotes/origin/main\0origin/main',
            'refs/remotes/upstream/feature-x\0upstream/feature-x',
            'refs/remotes/upstream/HEAD\0upstream/HEAD',
            'refs/heads/local-only\0local-only'
          ].join('\n'),
          stderr: ''
        })
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.searchRepoRefs('id:remote-repo', '', 2)

    expect(result).toEqual({
      refs: ['origin/main', 'upstream/feature-x'],
      refDetails: [
        { refName: 'origin/main', localBranchName: 'main' },
        { refName: 'upstream/feature-x', localBranchName: 'feature-x' }
      ],
      truncated: true
    })
    expect(provider.exec).toHaveBeenCalledWith(
      expect.arrayContaining([
        '--exclude=refs/remotes/**/HEAD',
        '--count=12',
        'refs/heads/**/**',
        'refs/heads/**/**/**',
        'refs/remotes/**/**',
        'refs/remotes/**/**/**'
      ]),
      '/home/user/repo'
    )
    expect(provider.exec).toHaveBeenCalledWith(['remote'], '/home/user/repo')
  })

  it('retries runtime SSH ref searches without --exclude for older git hosts', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: () => remoteRepo
    }
    const provider = {
      exec: vi.fn().mockImplementation((argv: string[]) => {
        if (argv[0] === 'remote') {
          return Promise.resolve({ stdout: 'origin\n', stderr: '' })
        }
        if (argv.includes('--exclude=refs/remotes/**/HEAD')) {
          return Promise.reject(
            Object.assign(new Error("unknown option `exclude'"), {
              stderr: "error: unknown option `exclude'"
            })
          )
        }
        return Promise.resolve({
          stdout: [
            'refs/remotes/origin/main\0origin/main',
            'refs/remotes/origin/HEAD\0origin/HEAD',
            'refs/remotes/origin/feature-x\0origin/feature-x'
          ].join('\n'),
          stderr: ''
        })
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.searchRepoRefs('id:remote-repo', '', 1)

    expect(result).toEqual({
      refs: ['origin/main'],
      refDetails: [{ refName: 'origin/main', localBranchName: 'main' }],
      truncated: true
    })
    const forEachRefCalls = provider.exec.mock.calls.filter(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )
    expect(forEachRefCalls).toHaveLength(2)
    expect(forEachRefCalls[0][0]).toContain('--exclude=refs/remotes/**/HEAD')
    expect(forEachRefCalls[1][0]).not.toContain('--exclude=refs/remotes/**/HEAD')
    expect(forEachRefCalls[1][0]).toContain('--count=108')
  })

  it('resolves SSH worktrees when manually updating lineage', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' }),
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId, lineage) => lineage)
    const listSshWorktrees = vi.fn().mockResolvedValue([
      {
        path: '/home/user/repo-child',
        head: 'abc',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/home/user/repo-parent',
        head: 'def',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getSshGitProviderMock.mockReturnValue({ listWorktrees: listSshWorktrees })
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(listSshWorktrees).toHaveBeenCalledWith(remoteRepo.path)
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual'
      })
    )
  })

  it('keeps workspace lineage in sync when manually reparenting a worktree', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    const setWorkspaceLineage = vi.fn((lineage: WorkspaceLineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage,
      setWorkspaceLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        capture: { source: 'manual-action', confidence: 'explicit' }
      })
    )
    expect(setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        childWorkspaceKey: `worktree:${childId}`,
        childInstanceId: 'child-instance',
        parentWorkspaceKey: `worktree:${parentId}`,
        parentInstanceId: 'parent-instance',
        capture: { source: 'manual-action', confidence: 'explicit' }
      })
    )
  })

  it('clears workspace lineage when manually removing a parent', async () => {
    const childPath = '/tmp/worktree-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const removeWorktreeLineage = vi.fn()
    const removeWorkspaceLineage = vi.fn()
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeLineage,
      removeWorkspaceLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { noParent: true }
    })

    expect(removeWorktreeLineage).toHaveBeenCalledWith(childId)
    expect(removeWorkspaceLineage).toHaveBeenCalledWith(`worktree:${childId}`)
  })

  it('strips Orca provenance fields from runtime metadata updates', async () => {
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const setWorktreeMeta = vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
      return metaById[worktreeId]
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${TEST_WORKTREE_ID}`, {
      comment: 'keep me',
      orcaCreatedAt: 123,
      orcaCreationSource: 'runtime',
      orcaCreationWorkspaceLayout: { path: '/tmp', nestWorkspaces: false }
    })

    expect(setWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, { comment: 'keep me' })
  })

  it('ignores stale instance-mismatched lineage when validating manual cycle repairs', async () => {
    const parentPath = '/tmp/worktree-a'
    const childPath = '/tmp/worktree-b'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'new-parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) =>
        worktreeId === parentId
          ? {
              worktreeId: parentId,
              worktreeInstanceId: 'old-parent-instance',
              parentWorktreeId: childId,
              parentWorktreeInstanceId: 'child-instance',
              origin: 'manual' as const,
              capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
              createdAt: 1
            }
          : undefined,
      setWorktreeLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/a',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/b',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'new-parent-instance'
      })
    )
  })

  it('backfills instanceId during runtime selector resolution for upgraded metadata', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta(),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = {
          ...metaById[worktreeId],
          ...meta,
          instanceId: meta.instanceId ?? metaById[worktreeId]?.instanceId ?? 'backfilled-instance'
        }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage: vi.fn((_worktreeId: string, lineage) => lineage)
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(runtimeStore.setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeInstanceId: 'child-instance',
        parentWorktreeInstanceId: 'backfilled-instance'
      })
    )
  })

  it('rotates a missing parent instance during runtime selector scans before same-path reuse', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'old-parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'old-parent-instance',
        origin: 'manual' as const,
        capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
        createdAt: 1
      }
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId],
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage: vi.fn((worktreeId: string) => {
        delete lineageById[worktreeId]
      }),
      setWorktreeLineage
    }
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValue([
        {
          path: childPath,
          head: 'def',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        },
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.showManagedWorktree(`id:${childId}`)
    const rotatedParentInstance = metaById[parentId].instanceId
    expect(rotatedParentInstance).toBeTruthy()
    expect(rotatedParentInstance).not.toBe('old-parent-instance')
    await runtime.updateManagedWorktreeMeta(`id:${childId}`, { comment: 'rescanned' })
    expect(metaById[parentId].instanceId).toBe(rotatedParentInstance)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, { comment: 'touch' })
    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeInstanceId: 'child-instance',
        parentWorktreeInstanceId: rotatedParentInstance
      })
    )
  })

  it('does not prune lineage when a runtime local worktree scan fails', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const removeWorktreeLineage = vi.fn((worktreeId: string) => {
      delete lineageById[worktreeId]
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }),
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage
    }
    vi.mocked(listWorktrees).mockRejectedValueOnce(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.showManagedWorktree(`id:${childId}`)).rejects.toThrow('selector_not_found')

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
    expect(runtimeStore.setWorktreeMeta).not.toHaveBeenCalled()
    expect(lineageById[childId]).toBeTruthy()
    expect(metaById[parentId].instanceId).toBe('parent-instance')
  })

  it('returns a non-authoritative detected list when a runtime local worktree scan fails', async () => {
    const removeWorktreeLineage = vi.fn()
    const runtimeStore = {
      ...store,
      getAllWorktreeLineage: () => ({}),
      removeWorktreeLineage
    }
    vi.mocked(listWorktrees).mockRejectedValueOnce(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).resolves.toEqual({
      repoId: TEST_REPO_ID,
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: []
    })

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
  })

  it('does not prune lineage when an SSH runtime provider is unavailable', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const removeWorktreeLineage = vi.fn((worktreeId: string) => {
      delete lineageById[worktreeId]
    })
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }),
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.showManagedWorktree(`id:${childId}`)).resolves.toMatchObject({
      id: childId,
      parentWorktreeId: parentId,
      lineage: lineageById[childId]
    })

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
    expect(runtimeStore.setWorktreeMeta).not.toHaveBeenCalled()
    expect(lineageById[childId]).toBeTruthy()
    expect(metaById[parentId].instanceId).toBe('parent-instance')
  })

  it('exposes valid parent and child lineage in CLI worktree records', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'parent'
      }),
      [childId]: makeWorktreeMeta({
        instanceId: 'child-instance',
        displayName: 'child'
      })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getAllWorktreeLineage: () => lineageById
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const listed = await runtime.listManagedWorktrees('id:repo-1')
    const parent = listed.worktrees.find((worktree) => worktree.id === parentId)
    const child = listed.worktrees.find((worktree) => worktree.id === childId)

    expect(parent).toMatchObject({
      parentWorktreeId: null,
      childWorktreeIds: [childId],
      lineage: null
    })
    expect(child).toMatchObject({
      parentWorktreeId: parentId,
      childWorktreeIds: [],
      lineage: lineageById[childId]
    })
    await expect(runtime.showManagedWorktree(`id:${childId}`)).resolves.toMatchObject({
      id: childId,
      parentWorktreeId: parentId,
      childWorktreeIds: [],
      lineage: lineageById[childId]
    })
  })

  it('keeps valid orchestration lineage when caller terminal context is stale', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/workspaces/worker-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'coordinator'
      })
    }
    const setWorktreeLineage = vi.fn((worktreeId: string, lineage) => {
      metaById[worktreeId] = metaById[worktreeId] ?? makeWorktreeMeta()
      return lineage
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta({ instanceId: 'child-instance' })
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/coordinator',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'worker-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'worker-child',
      lineage: {
        callerTerminalHandle: 'term_stale',
        orchestrationContext: {
          parentWorktreeId: parentId,
          orchestrationRunId: 'run-1',
          taskId: 'task-1',
          coordinatorHandle: 'term_coord'
        }
      }
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: parentId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      orchestrationRunId: 'run-1',
      taskId: 'task-1',
      coordinatorHandle: 'term_coord'
    })
    expect(result.lineage).not.toHaveProperty('createdByTerminalHandle')
    expect(result.warnings).toEqual([])
    expect(setWorktreeLineage).toHaveBeenCalledWith(childId, expect.any(Object))
  })

  it('enriches caller-terminal lineage with active orchestration dispatch context', async () => {
    const workerPath = '/tmp/worktree-worker'
    const childPath = '/tmp/workspaces/worker-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const workerId = `${TEST_REPO_ID}::${workerPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'coordinator'
      }),
      [workerId]: makeWorktreeMeta({
        instanceId: 'worker-instance',
        displayName: 'worker'
      })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    const coordinatorHandle = runtime.preAllocateHandleForPty('pty-coordinator')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn(() => ({
        task_id: 'task-1'
      })),
      getActiveCoordinatorRun: vi.fn(() => ({
        id: 'run-1',
        coordinator_handle: coordinatorHandle
      }))
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          title: 'Worker',
          activeLeafId: 'pane:1',
          layout: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Coordinator',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 2,
          ptyId: 'pty-coordinator',
          paneTitle: null
        }
      ]
    })
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        ...MOCK_GIT_WORKTREES,
        {
          path: workerPath,
          head: 'fed',
          branch: 'feature/worker',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'worker-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'worker-child',
      lineage: { callerTerminalHandle: workerHandle }
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: workerId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      orchestrationRunId: 'run-1',
      taskId: 'task-1',
      coordinatorHandle,
      createdByTerminalHandle: workerHandle
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeInstanceId: expect.not.stringMatching(/^old-/),
        parentWorktreeInstanceId: 'worker-instance'
      })
    )
  })

  it('returns active orchestration context for renderer-synced terminal leaves', () => {
    const runtime = new OrcaRuntimeService(store)
    const workerLeafId = '11111111-1111-4111-8111-111111111111'
    const coordinatorLeafId = '22222222-2222-4222-8222-222222222222'
    const workerPaneKey = makePaneKey('tab-worker', workerLeafId)
    const coordinatorPaneKey = makePaneKey('tab-coordinator', coordinatorLeafId)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    const coordinatorHandle = runtime.preAllocateHandleForPty('pty-coordinator')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-1',
              task_id: 'task-1',
              assignee_handle: workerHandle,
              status: 'dispatched'
            }
          : undefined
      ),
      getLatestDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-done',
              task_id: 'task-done',
              assignee_handle: workerHandle,
              status: 'completed',
              completed_at: new Date(Date.now()).toISOString()
            }
          : undefined
      ),
      getTask: vi.fn(() => ({
        id: 'task-1',
        created_by_terminal_handle: coordinatorHandle
      })),
      getActiveCoordinatorRun: vi.fn(() => ({
        id: 'run-1',
        coordinator_handle: coordinatorHandle
      }))
    } as never)
    runtime.attachWindow(1)

    const result = runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude Code',
          activeLeafId: workerLeafId,
          layout: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: coordinatorLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          leafId: workerLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          leafId: coordinatorLeafId,
          paneRuntimeId: 2,
          ptyId: 'pty-coordinator',
          paneTitle: null
        }
      ]
    })

    expect(result.agentOrchestrationByPaneKey?.[workerPaneKey]).toMatchObject({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      parentPaneKey: coordinatorPaneKey,
      parentTerminalHandle: coordinatorHandle,
      coordinatorHandle,
      orchestrationRunId: 'run-1'
    })
  })

  it('returns completed orchestration context for renderer-synced terminal leaves', () => {
    const runtime = new OrcaRuntimeService(store)
    const workerLeafId = '33333333-3333-4333-8333-333333333333'
    const coordinatorLeafId = '44444444-4444-4444-8444-444444444444'
    const workerPaneKey = makePaneKey('tab-worker', workerLeafId)
    const coordinatorPaneKey = makePaneKey('tab-coordinator', coordinatorLeafId)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    const coordinatorHandle = runtime.preAllocateHandleForPty('pty-coordinator')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn(() => undefined),
      getLatestDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-done',
              task_id: 'task-done',
              assignee_handle: workerHandle,
              status: 'completed',
              completed_at: new Date(Date.now()).toISOString()
            }
          : undefined
      ),
      getTask: vi.fn(() => ({
        id: 'task-done',
        created_by_terminal_handle: coordinatorHandle
      }))
    } as never)
    runtime.attachWindow(1)

    const result = runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude Code',
          activeLeafId: workerLeafId,
          layout: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: coordinatorLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          leafId: workerLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        },
        {
          tabId: 'tab-coordinator',
          worktreeId: TEST_WORKTREE_ID,
          leafId: coordinatorLeafId,
          paneRuntimeId: 2,
          ptyId: 'pty-coordinator',
          paneTitle: null
        }
      ]
    })

    expect(result.agentOrchestrationByPaneKey?.[workerPaneKey]).toMatchObject({
      taskId: 'task-done',
      dispatchId: 'ctx-done',
      parentPaneKey: coordinatorPaneKey,
      parentTerminalHandle: coordinatorHandle
    })
  })

  it('does not attach an unrelated active coordinator run to a completed dispatch', () => {
    const runtime = new OrcaRuntimeService(store)
    const workerLeafId = '55555555-5555-4555-8555-555555555555'
    const workerPaneKey = makePaneKey('tab-worker', workerLeafId)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn(() => undefined),
      getLatestDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-done',
              task_id: 'task-done',
              assignee_handle: workerHandle,
              status: 'completed',
              completed_at: new Date(Date.now()).toISOString()
            }
          : undefined
      ),
      getTask: vi.fn(() => ({
        id: 'task-done'
      })),
      getActiveCoordinatorRun: vi.fn(() => ({
        id: 'run-unrelated',
        coordinator_handle: 'term_unrelated'
      }))
    } as never)
    runtime.attachWindow(1)

    const result = runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude Code',
          activeLeafId: workerLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          leafId: workerLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        }
      ]
    })

    expect(result.agentOrchestrationByPaneKey?.[workerPaneKey]).toEqual({
      taskId: 'task-done',
      dispatchId: 'ctx-done'
    })
  })

  it('does not return stale completed orchestration context for renderer-synced terminal leaves', () => {
    const runtime = new OrcaRuntimeService(store)
    const workerLeafId = '77777777-7777-4777-8777-777777777777'
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn(() => undefined),
      getLatestDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-stale',
              task_id: 'task-stale',
              assignee_handle: workerHandle,
              status: 'completed',
              completed_at: new Date(Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1).toISOString()
            }
          : undefined
      )
    } as never)
    runtime.attachWindow(1)

    const result = runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude Code',
          activeLeafId: workerLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: TEST_WORKTREE_ID,
          leafId: workerLeafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        }
      ]
    })

    expect(result.agentOrchestrationByPaneKey).toBeUndefined()
  })

  it('falls back to cwd lineage when the caller terminal handle is stale', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/workspaces/cwd-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'cwd-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'cwd-child',
      lineage: {
        callerTerminalHandle: 'term_stale',
        cwdParentWorktree: `id:${parentId}`
      }
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: parentId,
      origin: 'cli',
      capture: { source: 'cwd-context', confidence: 'inferred' }
    })
    expect(result.worktree).toMatchObject({
      parentWorktreeId: parentId,
      childWorktreeIds: [],
      lineage: result.lineage
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(childId, expect.any(Object))
  })

  it('keeps cwd-inferred lineage best-effort when the cwd parent cannot be resolved', async () => {
    const childPath = '/tmp/workspaces/no-cwd-parent'
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'no-cwd-parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
    const runtime = new OrcaRuntimeService(store)

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'no-cwd-parent',
      lineage: {
        cwdParentWorktree: 'id:repo-1::/tmp/missing-parent'
      }
    })

    expect(result.lineage).toBeNull()
    expect(result.worktree).toMatchObject({
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    })
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'LINEAGE_PARENT_CONTEXT_MISSING',
        message:
          'Worktree created, but Orca could not validate the current directory as a parent workspace.'
      })
    ])
  })

  it('infers orchestration lineage from task-id comments when dispatch is completed', async () => {
    const workerPath = '/tmp/worktree-worker'
    const childPath = '/tmp/workspaces/worker-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const workerId = `${TEST_REPO_ID}::${workerPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [workerId]: makeWorktreeMeta({
        instanceId: 'worker-instance',
        displayName: 'worker'
      })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
    runtime.setOrchestrationDb({
      getDispatchContext: vi.fn(() => ({
        task_id: 'task_abc123',
        assignee_handle: workerHandle,
        status: 'completed'
      }))
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          title: 'Worker',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: workerId,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-worker',
          paneTitle: null
        }
      ]
    })
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: workerPath,
          head: 'fed',
          branch: 'feature/worker',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'worker-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'worker-child',
      comment: 'Created via orchestration task task_abc123'
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: workerId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      taskId: 'task_abc123'
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        parentWorktreeInstanceId: 'worker-instance'
      })
    )
  })

  it('infers orchestration lineage from task creator when no dispatch context exists', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/workspaces/parent-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        displayName: 'parent'
      })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existing = metaById[worktreeId] ?? makeWorktreeMeta()
        metaById[worktreeId] = { ...existing, ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const parentHandle = runtime.preAllocateHandleForPty('pty-parent')
    runtime.setOrchestrationDb({
      getDispatchContext: vi.fn(() => undefined),
      getTask: vi.fn(() => ({
        id: 'task_creator123',
        created_by_terminal_handle: parentHandle
      }))
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-parent',
          worktreeId: parentId,
          title: 'Parent',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-parent',
          worktreeId: parentId,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-parent',
          paneTitle: null
        }
      ]
    })
    computeWorktreePathMock.mockReturnValue(childPath)
    ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: parentPath,
          head: 'fed',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'parent-child',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'parent-child',
      comment: 'Created via orchestration task task_creator123'
    })

    expect(result.lineage).toMatchObject({
      worktreeId: childId,
      parentWorktreeId: parentId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' },
      taskId: 'task_creator123'
    })
    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        parentWorktreeInstanceId: 'parent-instance'
      })
    )
  })

  it('returns a setup launch payload for CLI-created worktrees when hooks are explicitly enabled', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-test')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-test')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-test'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-hook-test',
        head: 'def',
        branch: 'runtime-hook-test',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-test',
      runHooks: true
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', path: '/tmp/repo' }),
      '/tmp/workspaces/runtime-hook-test',
      'pnpm worktree:setup'
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(addWorktree).toHaveBeenCalledWith(
      '/tmp/repo',
      '/tmp/workspaces/runtime-hook-test',
      'runtime-hook-test',
      'origin/main',
      false
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/tmp/workspaces/runtime-hook-test',
        branch: 'runtime-hook-test'
      }),
      setup: {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: {
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-test'
        }
      }
    })
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      result.setup,
      undefined,
      undefined
    )
  })

  it('passes setup payloads through when explicitly activating CLI-created worktrees', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-activate')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-activate')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-activate'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-hook-activate',
        head: 'def',
        branch: 'runtime-hook-activate',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-activate',
      runHooks: true,
      activate: true
    })

    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      result.setup,
      undefined,
      undefined
    )
  })

  it('follows normal setup policy for CLI-created worktrees without activating them', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-primary' })
      .mockResolvedValueOnce({ id: 'pty-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hook-skip')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hook-skip')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-skip'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-hook-skip',
        head: 'def',
        branch: 'runtime-hook-skip',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hook-skip'
    })

    expect(createSetupRunnerScript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', path: '/tmp/repo' }),
      '/tmp/workspaces/runtime-hook-skip',
      'pnpm worktree:setup'
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/tmp/workspaces/runtime-hook-skip',
        branch: 'runtime-hook-skip'
      }),
      setup: {
        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
        envVars: {
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-skip'
        }
      }
    })
    expect(activateWorktree).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-hook-skip',
        command: undefined,
        worktreeId: result.worktree.id
      })
    )
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-hook-skip',
        command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
        // Why: createTerminal stamps ORCA_PANE_KEY/TAB_ID/WORKTREE_ID into the
        // PTY env on top of the caller-supplied env so hook-based agent status
        // can attribute hook events to a stable pane.
        env: expect.objectContaining({
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-hook-skip',
          ORCA_TAB_ID: expect.stringMatching(UUID_RE),
          ORCA_PANE_KEY: expect.any(String),
          ORCA_WORKTREE_ID: result.worktree.id
        }),
        worktreeId: result.worktree.id
      })
    )
    const setupSpawnEnv =
      (spawn.mock.calls[1]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expectStablePaneKeyEnv(setupSpawnEnv)
    const setupLeafId = setupSpawnEnv.ORCA_PANE_KEY.slice(`${setupSpawnEnv.ORCA_TAB_ID}:`.length)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(result.worktree.id, {
      ptyId: 'pty-setup',
      title: 'Setup',
      activate: false,
      tabId: setupSpawnEnv.ORCA_TAB_ID,
      leafId: setupLeafId
    })
  })

  it('creates the first terminal for CLI-created worktrees without activating them', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-created-worktree' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-initial-terminal')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-initial-terminal')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-initial-terminal',
        head: 'def',
        branch: 'runtime-initial-terminal',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-initial-terminal'
    })

    expect(activateWorktree).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-initial-terminal',
        worktreeId: result.worktree.id,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    const initialSpawnEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expectStablePaneKeyEnv(initialSpawnEnv)
    const initialLeafId = initialSpawnEnv.ORCA_PANE_KEY.slice(
      `${initialSpawnEnv.ORCA_TAB_ID}:`.length
    )
    expect(revealTerminalSession).toHaveBeenCalledWith(result.worktree.id, {
      ptyId: 'pty-created-worktree',
      title: null,
      activate: false,
      tabId: initialSpawnEnv.ORCA_TAB_ID,
      leafId: initialLeafId
    })
  })

  it('honors split setup placement for CLI-created worktrees without startup agents', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-vertical' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-cli-setup-split' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-cli-setup-main' })
      .mockResolvedValueOnce({ id: 'pty-cli-setup-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-split')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-split')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm install'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-cli-setup-split'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-setup-split',
        head: 'def',
        branch: 'runtime-cli-setup-split',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-cli-setup-split',
      setupDecision: 'run'
    })

    expect(activateWorktree).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(2)
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
    expectStablePaneKeyEnv(mainEnv)
    expectStablePaneKeyEnv(setupEnv)
    expect(setupEnv.ORCA_TAB_ID).toBe(mainEnv.ORCA_TAB_ID)
    const mainLeafId = mainEnv.ORCA_PANE_KEY!.slice(`${mainEnv.ORCA_TAB_ID!}:`.length)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-cli-setup-setup',
        tabId: mainEnv.ORCA_TAB_ID,
        activate: false,
        splitFromLeafId: mainLeafId,
        splitDirection: 'vertical'
      })
    )
  })

  it('does not warn when setup is explicitly skipped for CLI-created worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-setup-skip' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-setup-skip' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-skip')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-skip')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { setup: 'pnpm worktree:setup' }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-setup-skip',
        head: 'def',
        branch: 'runtime-cli-setup-skip',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-cli-setup-skip',
      setupDecision: 'skip'
    })

    expect(result.warning).toBeUndefined()
    expect(createSetupRunnerScript).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('uses desktop task agent selection and bracketed-pastes startup drafts for local worktrees', async () => {
    detectInstalledAgentsMock.mockResolvedValue(['claude'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        agentCmdOverrides: { codex: 'codex --profile work' }
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-startup-draft' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-startup-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-draft',
        head: 'def',
        branch: 'runtime-startup-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const draftUrl = 'https://github.com/stablyai/orca/issues/123'
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-draft',
      startupDraft: draftUrl,
      activate: true
    })

    expect(detectInstalledAgentsMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-draft',
        command: "codex --profile work '--dangerously-bypass-approvals-and-sandbox'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })

    runtime.onPtyData('pty-startup-draft', '\x1b[?2004h›', Date.now())
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('pty-startup-draft', `\x1b[200~${draftUrl}\x1b[201~`)
    })
  })

  it('rejects explicit startup commands for disabled selected agents', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex' as const]
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-disabled-startup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'disabled-startup',
        startup: { command: 'codex' },
        createdWithAgent: 'codex'
      })
    ).rejects.toThrow('Selected agent is disabled. Choose an enabled agent before creating.')

    expect(spawn).not.toHaveBeenCalled()
    expect(addWorktree).not.toHaveBeenCalled()
  })

  it('launches explicit startup agents with prompts for CLI-created worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-agent-startup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-agent-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-agent-startup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-agent-startup')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-agent-startup',
        head: 'def',
        branch: 'runtime-cli-agent-startup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-cli-agent-startup',
      startupAgent: 'codex',
      startupPrompt: 'hi'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-cli-agent-startup',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'hi'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
  })

  it('sends follow-up prompts for CLI-created stdin-after-start startup agents', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-aider-startup' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => 'aider'
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-aider-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-startup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-startup')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-aider-startup',
        head: 'def',
        branch: 'runtime-cli-aider-startup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-cli-aider-startup',
      startupAgent: 'aider',
      startupPrompt: 'fix it'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-cli-aider-startup',
        command: "aider '--yes-always'",
        worktreeId: result.worktree.id
      })
    )
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('pty-cli-aider-startup', 'fix it\r')
    })
  })

  it('does not send stdin-after-start prompts into a shell when the agent never starts', async () => {
    vi.useFakeTimers()
    try {
      const metaById: Record<string, WorktreeMeta> = {}
      const runtimeStore = {
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          agentCmdOverrides: {}
        }),
        getAllWorktreeMeta: () => metaById,
        getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
        setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
          metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
          return metaById[worktreeId]
        }
      }
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-cli-aider-shell' }),
        write,
        kill: () => true,
        getForegroundProcess: async () => 'zsh',
        hasChildProcesses: vi.fn().mockResolvedValue(false)
      })
      runtime.setNotifier({
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-aider-shell' }),
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        focusTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      runtime.attachWindow(1)

      computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-shell')
      ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-shell')
      vi.mocked(listWorktrees).mockResolvedValue([
        {
          path: '/tmp/workspaces/runtime-cli-aider-shell',
          head: 'def',
          branch: 'runtime-cli-aider-shell',
          isBare: false,
          isMainWorktree: false
        }
      ])

      await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'runtime-cli-aider-shell',
        startupAgent: 'aider',
        startupPrompt: 'fix it'
      })

      await vi.advanceTimersByTimeAsync(6000)

      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records the resolved fallback agent when the requested startup draft agent is disabled', async () => {
    detectInstalledAgentsMock.mockResolvedValue(['claude'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        disabledTuiAgents: ['codex' as const],
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-fallback-draft' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-fallback-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-fallback-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-fallback-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-fallback-draft',
        head: 'def',
        branch: 'runtime-fallback-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-fallback-draft',
      startupDraft: 'https://github.com/stablyai/orca/issues/456',
      createdWithAgent: 'codex',
      activate: true
    })

    expect(detectInstalledAgentsMock).toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-fallback-draft',
        command: expect.stringContaining('claude'),
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'claude' })
  })

  it('honors split setup placement for local startup-draft worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        setupScriptLaunchMode: 'split-vertical' as const
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-startup-split-main' })
      .mockResolvedValueOnce({ id: 'pty-startup-split-setup' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-startup-split' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-split')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-split')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-split'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-setup-split',
        head: 'def',
        branch: 'runtime-startup-setup-split',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-setup-split',
      startupDraft: 'https://github.com/stablyai/orca/issues/123',
      setupDecision: 'run',
      activate: true
    })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-setup-split',
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        worktreeId: result.worktree.id
      })
    )
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-setup-split',
        command: 'bash /tmp/repo/.git/orca/setup-runner.sh',
        env: expect.objectContaining({
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-split',
          ORCA_WORKTREE_ID: result.worktree.id
        }),
        worktreeId: result.worktree.id
      })
    )
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
    expect(mainEnv.ORCA_TAB_ID).toBeDefined()
    expect(mainEnv.ORCA_PANE_KEY).toBeDefined()
    expect(setupEnv.ORCA_TAB_ID).toBe(mainEnv.ORCA_TAB_ID)
    const mainLeafId = mainEnv.ORCA_PANE_KEY!.slice(`${mainEnv.ORCA_TAB_ID!}:`.length)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-startup-split-setup',
        tabId: mainEnv.ORCA_TAB_ID,
        activate: false,
        splitFromLeafId: mainLeafId,
        splitDirection: 'vertical'
      })
    )
  })

  it('lets explicit startup draft agents override the desktop default', async () => {
    detectInstalledAgentsMock.mockResolvedValue([])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'claude' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-explicit-draft' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-explicit-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-explicit-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-explicit-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-explicit-draft',
        head: 'def',
        branch: 'runtime-explicit-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const draftUrl = 'https://github.com/stablyai/orca/issues/789'
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-explicit-draft',
      startupDraft: draftUrl,
      createdWithAgent: 'codex',
      activate: true
    })

    expect(detectInstalledAgentsMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-explicit-draft',
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })

    runtime.onPtyData('pty-explicit-draft', '\x1b[?2004h›', Date.now())
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('pty-explicit-draft', `\x1b[200~${draftUrl}\x1b[201~`)
    })
  })

  it('does not auto-launch an agent for startup drafts when the default is blank', async () => {
    detectInstalledAgentsMock.mockResolvedValue(['claude', 'codex'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'blank' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-blank-draft' })
    const activateWorktree = vi.fn()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-blank-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-blank-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-blank-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-blank-draft',
        head: 'def',
        branch: 'runtime-blank-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-blank-draft',
      startupDraft: 'https://github.com/stablyai/orca/issues/123',
      activate: true
    })

    expect(detectInstalledAgentsMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(metaById[result.worktree.id]?.createdWithAgent).toBeUndefined()
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      result.worktree.id,
      undefined,
      undefined,
      undefined
    )
  })

  it('detects agents on the SSH host before launching remote startup drafts', async () => {
    detectRemoteAgentsMock.mockResolvedValue(['claude'])
    const created = {
      path: '/remote/mobile-startup-draft',
      head: 'def',
      branch: 'refs/heads/mobile-startup-draft',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: null,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-startup-draft' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const draftUrl = 'https://github.com/stablyai/orca/pull/456'
    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'mobile-startup-draft',
      startupDraft: draftUrl
    })

    expect(detectRemoteAgentsMock).toHaveBeenCalledWith({ connectionId: 'ssh-1' })
    expect(detectInstalledAgentsMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/remote/mobile-startup-draft',
        command: `claude '--dangerously-skip-permissions' --prefill '${draftUrl}'`,
        connectionId: 'ssh-1',
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'claude' })
  })

  it('pre-marks remote Codex workspaces trusted before pasting startup drafts', async () => {
    detectRemoteAgentsMock.mockResolvedValue(['codex'])
    muxRequestMock.mockResolvedValue({ resolvedPath: '/home/dev' })
    const created = {
      path: '/remote/mobile-codex-draft',
      head: 'def',
      branch: 'refs/heads/mobile-codex-draft',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const gitProvider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      realpath: vi.fn().mockResolvedValue('/remote/mobile-codex-draft'),
      readFile: vi.fn().mockRejectedValue(new Error('missing config')),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-codex-draft' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-codex-draft',
        startupDraft: 'https://github.com/stablyai/orca/issues/789'
      })

      expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
      expect(muxRequestMock).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
      expect(fsProvider.createDir).toHaveBeenCalledWith('/home/dev/.codex')
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('[projects."/remote/mobile-codex-draft"]')
      )
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('trust_level = "trusted"')
      )
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/mobile-codex-draft',
          command: "codex '--dangerously-bypass-approvals-and-sandbox'",
          connectionId: 'ssh-1',
          worktreeId: result.worktree.id
        })
      )
      expect(fsProvider.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        spawn.mock.invocationCallOrder[0]!
      )
      expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('pre-marks remote Codex workspaces trusted before explicit startup commands', async () => {
    muxRequestMock.mockResolvedValue({ resolvedPath: '/home/dev' })
    const created = {
      path: '/remote/mobile-codex-command',
      head: 'def',
      branch: 'refs/heads/mobile-codex-command',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => store.getSettings(),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const gitProvider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      realpath: vi.fn().mockResolvedValue('/remote/mobile-codex-command'),
      readFile: vi.fn().mockRejectedValue(new Error('missing config')),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-codex-command' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-codex-command',
        startup: { command: 'codex' },
        createdWithAgent: 'codex'
      })

      expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
      expect(muxRequestMock).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('[projects."/remote/mobile-codex-command"]')
      )
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('trust_level = "trusted"')
      )
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/mobile-codex-command',
          command: 'codex',
          connectionId: 'ssh-1',
          worktreeId: result.worktree.id
        })
      )
      expect(fsProvider.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        spawn.mock.invocationCallOrder[0]!
      )
      expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('passes SSH connection ids through GitLab task operations', async () => {
    listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
    listGitLabWorkItemsMock.mockResolvedValue({ items: [] })
    listGitLabIssuesMock.mockResolvedValue({
      items: [
        {
          number: 7,
          title: 'Issue title',
          state: 'opened',
          url: 'https://gitlab.example/issues/7',
          labels: ['bug'],
          updatedAt: '2026-05-22T00:00:00Z',
          author: 'alex'
        }
      ]
    })
    listGitLabTodosMock.mockResolvedValue([])
    listGitLabLabelsMock.mockResolvedValue(['bug', 'frontend'])
    getGitLabWorkItemByProjectRefMock.mockResolvedValue({
      id: 'gitlab-issue-7',
      type: 'issue',
      number: 7
    })
    createGitLabIssueMock.mockResolvedValue({
      ok: true,
      number: 1,
      url: 'https://gitlab.example/issues/1'
    })
    updateGitLabIssueMock.mockResolvedValue({ ok: true })
    addGitLabIssueCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRInlineCommentMock.mockResolvedValue({ ok: true })
    resolveGitLabMRDiscussionMock.mockResolvedValue({ ok: true })
    getGitLabJobTraceMock.mockResolvedValue({ ok: true, trace: 'log' })
    retryGitLabJobMock.mockResolvedValue({ ok: true })
    mergeGitLabMRMock.mockResolvedValue({ ok: true })
    closeGitLabMRMock.mockResolvedValue({ ok: true })
    reopenGitLabMRMock.mockResolvedValue({ ok: true })
    getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
    updateGitLabMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })

    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.listGitLabRepoMRs(TEST_REPO_ID, 'closed', 2, 25, 'ambiguous selector')
    await runtime.listGitLabRepoWorkItems(TEST_REPO_ID, 'closed', 2, 25, 'ambiguous selector')
    const issues = await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'opened', '@me', 50)
    await runtime.listGitLabRepoTodos(TEST_REPO_ID)
    await runtime.listGitLabRepoLabels(TEST_REPO_ID)
    await runtime.createGitLabRepoIssue(TEST_REPO_ID, 'New issue', 'Body')
    await runtime.updateGitLabRepoIssue(TEST_REPO_ID, 7, { state: 'closed' })
    await runtime.addGitLabRepoIssueComment(TEST_REPO_ID, 7, 'Looks good')
    await runtime.addGitLabRepoMRComment(TEST_REPO_ID, 8, 'Ship it')
    const inlineCommentInput = {
      body: 'please fix',
      path: 'src/app.ts',
      line: 12,
      baseSha: 'base',
      startSha: 'start',
      headSha: 'head'
    }
    await runtime.addGitLabRepoMRInlineComment(TEST_REPO_ID, 8, inlineCommentInput)
    await runtime.resolveGitLabRepoMRDiscussion(TEST_REPO_ID, 8, 'discussion-1', true)
    await runtime.getGitLabRepoJobTrace(TEST_REPO_ID, 99)
    await runtime.retryGitLabRepoJob(TEST_REPO_ID, 99)
    await runtime.mergeGitLabRepoMR(TEST_REPO_ID, 8, 'squash')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'closed')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'opened')
    await runtime.getGitLabRepoWorkItemDetails(TEST_REPO_ID, 8, 'mr')
    await runtime.updateGitLabRepoMRReviewers(TEST_REPO_ID, 8, [1, 2])
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue'
    )

    expect(listGitLabMergeRequestsMock).toHaveBeenCalledWith(
      '/remote/repo',
      'closed',
      2,
      25,
      'origin',
      'ambiguous selector',
      'ssh-1'
    )
    expect(listGitLabWorkItemsMock).toHaveBeenCalledWith(
      '/remote/repo',
      'closed',
      2,
      25,
      'origin',
      'ambiguous selector',
      'ssh-1'
    )
    expect(listGitLabIssuesMock).toHaveBeenCalledWith(
      '/remote/repo',
      50,
      'origin',
      'opened',
      '@me',
      'ssh-1'
    )
    expect(issues.items).toEqual([
      {
        id: `gitlab-issue-${TEST_REPO_ID}-7`,
        type: 'issue',
        number: 7,
        title: 'Issue title',
        state: 'opened',
        url: 'https://gitlab.example/issues/7',
        labels: ['bug'],
        updatedAt: '2026-05-22T00:00:00Z',
        author: 'alex',
        repoId: TEST_REPO_ID
      }
    ])
    expect(listGitLabTodosMock).toHaveBeenCalledWith('/remote/repo', 'ssh-1')
    expect(listGitLabLabelsMock).toHaveBeenCalledWith('/remote/repo', 'origin', 'ssh-1')
    expect(createGitLabIssueMock).toHaveBeenCalledWith(
      '/remote/repo',
      'New issue',
      'Body',
      'origin',
      'ssh-1'
    )
    expect(updateGitLabIssueMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      { state: 'closed' },
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabIssueCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      'Looks good',
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabMRCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'Ship it',
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabMRInlineCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      inlineCommentInput,
      'origin',
      'ssh-1',
      undefined
    )
    expect(resolveGitLabMRDiscussionMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'discussion-1',
      true,
      'origin',
      'ssh-1',
      undefined
    )
    expect(getGitLabJobTraceMock).toHaveBeenCalledWith(
      '/remote/repo',
      99,
      'origin',
      'ssh-1',
      undefined
    )
    expect(retryGitLabJobMock).toHaveBeenCalledWith(
      '/remote/repo',
      99,
      'origin',
      'ssh-1',
      undefined
    )
    expect(mergeGitLabMRMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'squash',
      'origin',
      'ssh-1',
      undefined
    )
    expect(closeGitLabMRMock).toHaveBeenCalledWith('/remote/repo', 8, 'origin', 'ssh-1', undefined)
    expect(reopenGitLabMRMock).toHaveBeenCalledWith('/remote/repo', 8, 'origin', 'ssh-1', undefined)
    expect(getGitLabWorkItemDetailsMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'mr',
      'origin',
      'ssh-1',
      undefined
    )
    expect(updateGitLabMRReviewersMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      [1, 2],
      'origin',
      'ssh-1',
      undefined
    )
    expect(getGitLabWorkItemByProjectRefMock).toHaveBeenCalledWith(
      '/remote/repo',
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue',
      'ssh-1'
    )
  })

  it('normalizes runtime GitLab issue list arguments like the desktop IPC path', async () => {
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'closed', 'someone-else' as never, 250.8)
    await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'all', '@me', 0.7)
    await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'unexpected' as never, '@me', Number.NaN)

    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      1,
      TEST_REPO_PATH,
      100,
      undefined,
      'closed',
      undefined,
      null
    )
    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      2,
      TEST_REPO_PATH,
      1,
      undefined,
      'all',
      '@me',
      null
    )
    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      3,
      TEST_REPO_PATH,
      20,
      undefined,
      'opened',
      '@me',
      null
    )
  })

  it('records GitLab pasted-project recents only after successful runtime lookup', async () => {
    let settings = {
      ...store.getSettings(),
      gitlabProjects: {
        pinned: [{ host: 'gitlab.example.com', path: 'group/pinned' }],
        recent: []
      }
    }
    const updateSettings = vi.fn((updates: Record<string, unknown>) => {
      settings = { ...settings, ...updates } as typeof settings
    })
    const runtimeStore = {
      ...store,
      getSettings: () => settings,
      updateSettings
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    getGitLabWorkItemByProjectRefMock.mockResolvedValueOnce({
      id: 'gitlab-issue-7',
      type: 'issue',
      number: 7
    })
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue'
    )

    expect(updateSettings).toHaveBeenCalledWith({
      gitlabProjects: {
        pinned: [{ host: 'gitlab.example.com', path: 'group/pinned' }],
        recent: [
          expect.objectContaining({
            host: 'gitlab.example.com',
            path: 'group/project',
            lastOpenedAt: expect.any(String)
          })
        ]
      }
    })

    updateSettings.mockClear()
    getGitLabWorkItemByProjectRefMock.mockResolvedValueOnce(null)
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/missing' },
      404,
      'issue'
    )

    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('resolves local GitLab fork MR bases from the target project MR head ref', async () => {
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'FETCH_HEAD') {
        return { stdout: 'fork-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        isCrossRepository: true
      })

      expect(result).toEqual({ baseBranch: 'fork-mr-sha' })
      expect(gitSpy).toHaveBeenCalledWith(['fetch', 'origin', 'refs/merge-requests/42/head'], {
        cwd: TEST_REPO_PATH
      })
      expect(gitSpy).toHaveBeenCalledWith(['rev-parse', '--verify', 'FETCH_HEAD'], {
        cwd: TEST_REPO_PATH
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('resolves SSH GitLab fork MR bases from the target project MR head ref', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'FETCH_HEAD') {
          return { stdout: 'remote-fork-mr-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.resolveManagedMrBase({
      repoSelector: 'id:repo-1',
      mrIid: 77,
      sourceBranch: 'contrib/remote-fix',
      isCrossRepository: true
    })

    expect(result).toEqual({ baseBranch: 'remote-fork-mr-sha' })
    expect(provider.exec).toHaveBeenCalledWith(
      ['fetch', 'origin', 'refs/merge-requests/77/head'],
      '/remote/repo'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'FETCH_HEAD'],
      '/remote/repo'
    )
    expect(getGitLabProjectRefForRemoteMock).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      ['gitlab.com', 'git.internal'],
      'ssh-1'
    )
  })

  it('creates the first terminal by id when duplicate repo entries expose the same path', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-duplicate-path' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-duplicate-path' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    const duplicatePath = '/tmp/workspaces/runtime-duplicate-terminal'
    const getRepos = vi.spyOn(store, 'getRepos').mockReturnValue([
      {
        id: TEST_REPO_ID,
        path: TEST_REPO_PATH,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      },
      {
        id: 'repo-duplicate-entry',
        path: '/tmp/repo-secondary-worktree',
        displayName: 'repo-secondary-worktree',
        badgeColor: 'red',
        addedAt: 2
      }
    ])
    computeWorktreePathMock.mockReturnValue(duplicatePath)
    ensurePathWithinWorkspaceMock.mockReturnValue(duplicatePath)
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: duplicatePath,
        head: 'def',
        branch: 'runtime-duplicate-terminal',
        isBare: false,
        isMainWorktree: false
      }
    ])

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'runtime-duplicate-terminal'
      })

      expect(result.warning).toBeUndefined()
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: duplicatePath,
          worktreeId: result.worktree.id
        })
      )
    } finally {
      getRepos.mockRestore()
    }
  })

  it('resolves an exact path selector when duplicate repo entries expose the same path', async () => {
    const runtime = new OrcaRuntimeService(store)
    const duplicatePath = '/tmp/workspaces/runtime-duplicate-selector'
    const getRepos = vi.spyOn(store, 'getRepos').mockReturnValue([
      {
        id: TEST_REPO_ID,
        path: TEST_REPO_PATH,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      },
      {
        id: 'repo-duplicate-entry',
        path: '/tmp/repo-secondary-worktree',
        displayName: 'repo-secondary-worktree',
        badgeColor: 'red',
        addedAt: 2
      }
    ])
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: duplicatePath,
        head: 'def',
        branch: 'runtime-duplicate-selector',
        isBare: false,
        isMainWorktree: false
      }
    ])

    try {
      const worktree = await runtime.showManagedWorktree(`path:${duplicatePath}`)

      expect(worktree.id).toBe(`${TEST_REPO_ID}::${duplicatePath}`)
      expect(worktree.path).toBe(duplicatePath)
    } finally {
      getRepos.mockRestore()
    }
  })

  it('keeps CLI-created worktrees successful when initial terminal creation fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi.fn().mockRejectedValue(new Error('pty unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-terminal-fail')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-terminal-fail')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-terminal-fail',
        head: 'def',
        branch: 'runtime-terminal-fail',
        isBare: false,
        isMainWorktree: false
      }
    ])

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'runtime-terminal-fail'
        })
      ).resolves.toMatchObject({
        worktree: expect.objectContaining({
          path: '/tmp/workspaces/runtime-terminal-fail'
        }),
        warning:
          'Failed to create the initial terminal for /tmp/workspaces/runtime-terminal-fail: pty unavailable'
      })
      expect(spawn).toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        '[worktree-create] Failed to create the initial terminal for /tmp/workspaces/runtime-terminal-fail: pty unavailable'
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('activates CLI-created worktrees only when explicitly requested', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-activate')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-activate')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-activate',
        head: 'def',
        branch: 'runtime-activate',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-activate',
      activate: true
    })

    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      undefined,
      undefined,
      undefined
    )
  })

  it('stamps createdAt alongside lastActivityAt so CLI-created worktrees get the Recent-sort grace window', async () => {
    // Why: parity with createLocalWorktree / createRemoteWorktree. Without
    // createdAt, ambient PTY bumps in OTHER worktrees during the few seconds
    // after creation can push the new worktree below them in Recent sort.
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-grace')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-grace')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: {} })
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/runtime-grace',
        head: 'def',
        branch: 'runtime-grace',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const before = Date.now()
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-grace'
    })
    const after = Date.now()

    expect(result.worktree.createdAt).toBeDefined()
    expect(result.worktree.createdAt).toBeGreaterThanOrEqual(before)
    expect(result.worktree.createdAt).toBeLessThanOrEqual(after)
    // Both fields must be stamped from the same `now` so the grace-window
    // math (max(lastActivityAt, createdAt + GRACE_MS)) is well-defined.
    expect(result.worktree.createdAt).toBe(result.worktree.lastActivityAt)
  })

  it('skips archive hooks for CLI worktree removal by default', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })
    vi.mocked(removeWorktree).mockResolvedValue({})

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(runHook).not.toHaveBeenCalled()
    expect(removeWorktree).toHaveBeenCalledWith(TEST_REPO_PATH, TEST_WORKTREE_PATH, false)
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    expect(result.warning).toBe(
      `orca.yaml archive hook skipped for ${TEST_WORKTREE_PATH}; pass --run-hooks to run it.`
    )
  })

  it('force-deletes a branch that was preserved by runtime worktree removal', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.mocked(removeWorktree).mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)
    const result = await runtime.forceDeletePreservedBranch(
      TEST_WORKTREE_ID,
      'feature/test',
      'def456'
    )

    expect(result).toEqual({ deleted: true })
    expect(forceDeleteLocalBranchMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/test',
      'def456'
    )
  })

  it('rejects stale preserved-branch runtime cleanup actions with an old head', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.mocked(removeWorktree).mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'new456' }
    })

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    await expect(
      runtime.forceDeletePreservedBranch(TEST_WORKTREE_ID, 'feature/test', 'old123')
    ).rejects.toThrow('No preserved branch cleanup is pending')
    expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
  })

  it('coalesces concurrent runtime worktree removals for the same worktree id', async () => {
    const runtime = new OrcaRuntimeService(store)
    const removeStarted = deferred<void>()
    const finishRemoval = deferred<void>()
    vi.mocked(removeWorktree).mockImplementation(async () => {
      removeStarted.resolve()
      await finishRemoval.promise
      return {}
    })

    const first = runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)
    const second = runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)

    await removeStarted.promise
    await Promise.resolve()
    expect(removeWorktree).toHaveBeenCalledTimes(1)

    finishRemoval.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}])
  })

  it('rejects concurrent runtime worktree removals for the same id with different options', async () => {
    const runtime = new OrcaRuntimeService(store)
    const removeStarted = deferred<void>()
    const finishRemoval = deferred<void>()
    vi.mocked(removeWorktree).mockImplementation(async () => {
      removeStarted.resolve()
      await finishRemoval.promise
      return {}
    })

    const first = runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    await removeStarted.promise
    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)).rejects.toThrow(
      'Worktree deletion already in progress'
    )

    expect(removeWorktree).toHaveBeenCalledTimes(1)
    finishRemoval.resolve()
    await expect(first).resolves.toEqual({})
  })

  it('treats forced runtime deletion of an already-missing unregistered worktree as cleanup', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-remove-'))
    const missingWorktreePath = join(parentDir, 'already-deleted')
    const worktreeId = `${TEST_REPO_ID}::${missingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId, true)).resolves.toEqual({})

      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId)
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('treats normal runtime deletion of an already-missing unregistered worktree as cleanup', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-remove-'))
    const missingWorktreePath = join(parentDir, 'already-deleted')
    const worktreeId = `${TEST_REPO_ID}::${missingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId)).resolves.toEqual({})

      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId)
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('force-removes a legacy Orca-created runtime orphaned worktree directory after Git tracking is gone', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-orphan-'))
    const repoPath = join(parentDir, 'repo')
    const orphanPath = join(parentDir, 'orphan')
    const adminWorktreePath = join(repoPath, '.git', 'worktrees', 'orphan')
    const worktreeId = `${TEST_REPO_ID}::${orphanPath}`
    await mkdir(orphanPath, { recursive: true })
    await mkdir(adminWorktreePath, { recursive: true })
    await writeFile(join(orphanPath, '.git'), `gitdir: ${adminWorktreePath}\n`)
    await writeFile(join(adminWorktreePath, 'gitdir'), `${join(orphanPath, '.git')}\n`)
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId, {
      createdAt: Date.now()
    })
    const runtimeStoreWithRepoPath = {
      ...runtimeStore,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: repoPath,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      getRepo: (id: string) =>
        id === TEST_REPO_ID
          ? {
              id: TEST_REPO_ID,
              path: repoPath,
              displayName: 'repo',
              badgeColor: 'blue',
              addedAt: 1
            }
          : undefined
    }
    const runtime = new OrcaRuntimeService(runtimeStoreWithRepoPath as never)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId, true)).resolves.toEqual({})

      await expect(lstat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId)
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('does not inspect or delete a local path when SSH runtime orphan cleanup has no filesystem provider', async () => {
    const localPath = await mkdtemp(join(tmpdir(), 'orca-runtime-ssh-missing-fs-'))
    const repo = {
      id: 'repo-runtime-ssh-missing-fs',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-missing-fs'
    }
    const worktreeId = `${repo.id}::${localPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [worktreeId]: makeWorktreeMeta({
        orcaCreatedAt: Date.now(),
        orcaCreationSource: 'ssh'
      })
    }
    const removeWorktreeMeta = vi.fn((id: string) => {
      delete metaById[id]
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      setWorktreeMeta: (id: string, meta: Partial<WorktreeMeta>) => {
        metaById[id] = { ...(metaById[id] ?? makeWorktreeMeta()), ...meta }
        return metaById[id]
      },
      removeWorktreeMeta
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: repo.path,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    registerSshGitProvider(repo.connectionId, gitProvider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      await expect(runtime.removeManagedWorktree(`id:${worktreeId}`, true)).rejects.toThrow(
        'SSH filesystem provider unavailable'
      )

      await expect(lstat(localPath)).resolves.toBeTruthy()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider(repo.connectionId)
      await rm(localPath, { recursive: true, force: true })
    }
  })

  it('still rejects forced runtime unregistered delete paths that exist on disk', async () => {
    const existingWorktreePath = await mkdtemp(join(tmpdir(), 'orca-runtime-remove-existing-'))
    const worktreeId = `${TEST_REPO_ID}::${existingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId, true)).rejects.toThrow(
        'Refusing to delete unregistered worktree path'
      )

      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      await rm(existingWorktreePath, { recursive: true, force: true })
    }
  })

  it('rejects CLI worktree removal when the target contains another registered worktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: TEST_WORKTREE_PATH,
        head: 'parent',
        branch: 'refs/heads/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: `${TEST_WORKTREE_PATH}/child`,
        head: 'child',
        branch: 'refs/heads/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, true)).rejects.toThrow(
      `Refusing to delete worktree because it contains another registered worktree: ${TEST_WORKTREE_PATH}/child`
    )

    expect(runHook).not.toHaveBeenCalled()
    expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('fails dirty non-force deletes before PTY teardown', async () => {
    const runtime = new OrcaRuntimeService(store)
    const killSpy = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: (id) => killSpy(id),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(assertWorktreeCleanForRemoval).mockRejectedValue(
      Object.assign(new Error('Worktree has uncommitted or untracked changes.'), {
        stdout: '?? scratch.txt\n'
      })
    )

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
      `Failed to delete worktree at ${TEST_WORKTREE_PATH}. ?? scratch.txt`
    )

    expect(killSpy).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('formats preflight subprocess failures and skips PTY teardown', async () => {
    const runtime = new OrcaRuntimeService(store)
    const killSpy = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: (id) => killSpy(id),
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(assertWorktreeCleanForRemoval).mockRejectedValue(
      Object.assign(new Error('status failed'), {
        stderr: 'fatal: unable to read current working directory\n'
      })
    )

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
      `Failed to delete worktree at ${TEST_WORKTREE_PATH}. fatal: unable to read current working directory`
    )

    expect(killSpy).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('falls through to orphan cleanup when preflight reports missing/non-repo worktree', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(assertWorktreeCleanForRemoval).mockRejectedValue(
      Object.assign(new Error('status failed'), {
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
      })
    )
    vi.mocked(removeWorktree).mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: `fatal: '${TEST_WORKTREE_PATH}' is not a working tree`
      })
    )
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({ stdout: '', stderr: '' })

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).resolves.toEqual({})
    expect(removeWorktree).toHaveBeenCalledWith(TEST_REPO_PATH, TEST_WORKTREE_PATH, false)
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(TEST_WORKTREE_ID)
  })

  it('runs archive hooks for CLI worktree removal when hooks are explicitly enabled', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })
    vi.mocked(runHook).mockResolvedValue({ success: true, output: '' })
    vi.mocked(removeWorktree).mockResolvedValue({})

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID, false, true)

    expect(runHook).toHaveBeenCalledWith(
      'archive',
      TEST_WORKTREE_PATH,
      expect.objectContaining({ id: TEST_REPO_ID, path: TEST_REPO_PATH })
    )
    expect(removeWorktree).toHaveBeenCalledWith(TEST_REPO_PATH, TEST_WORKTREE_PATH, false)
  })

  it('clears optimistic reconcile tokens when a CLI worktree removal succeeds', async () => {
    const runtime = new OrcaRuntimeService(store)
    const worktreeBaseStatus = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      worktreeBaseStatus,
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    vi.mocked(removeWorktree).mockResolvedValue({})

    const token = runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)
    await runtime.reconcileWorktreeBaseStatus({
      repoId: TEST_REPO_ID,
      repoPath: TEST_REPO_PATH,
      worktreeId: TEST_WORKTREE_ID,
      base: {
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main',
        base: 'origin/main'
      },
      branchName: 'feature',
      createdBaseSha: 'created-sha',
      token,
      fetchPromise: Promise.resolve({ ok: true })
    })

    expect(worktreeBaseStatus).not.toHaveBeenCalled()
  })

  const remoteTrackingBase = {
    remote: 'origin',
    branch: 'main',
    ref: 'refs/remotes/origin/main',
    base: 'origin/main'
  }

  function createReconcileRuntime(): {
    runtime: OrcaRuntimeService
    worktreeBaseStatus: ReturnType<typeof vi.fn>
  } {
    const worktreeBaseStatus = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreeBaseStatus,
      worktreeRemoteBranchConflict: vi.fn()
    } as never)
    return { runtime, worktreeBaseStatus }
  }

  function mockReconcileGit(options: {
    postFetchSha?: string
    ancestor?: boolean
    baseRefMissing?: boolean
  }) {
    const { postFetchSha = 'new-base-sha', ancestor = true, baseRefMissing = false } = options

    return vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      const command = args as string[]
      const cwd = (options as { cwd?: string } | undefined)?.cwd
      if (
        cwd === TEST_REPO_PATH &&
        command[0] === 'rev-parse' &&
        command[1] === '--verify' &&
        command[2] === `${remoteTrackingBase.ref}^{commit}`
      ) {
        if (baseRefMissing) {
          throw new Error('missing base ref')
        }
        return { stdout: `${postFetchSha}\n`, stderr: '' }
      }
      if (cwd === TEST_REPO_PATH && command[0] === 'merge-base') {
        if (!ancestor) {
          throw new Error('not ancestor')
        }
        return { stdout: '', stderr: '' }
      }
      if (cwd === TEST_REPO_PATH && command[0] === 'rev-list') {
        return { stdout: '3\n', stderr: '' }
      }
      if (cwd === TEST_REPO_PATH && command[0] === 'log') {
        return { stdout: 'base commit 3\nbase commit 2\n', stderr: '' }
      }
      if (cwd === TEST_REPO_PATH && command[0] === 'config') {
        throw new Error('config missing')
      }
      if (
        cwd === TEST_REPO_PATH &&
        command[0] === 'rev-parse' &&
        command[1] === '--verify' &&
        command[2] === 'refs/remotes/origin/feature^{commit}'
      ) {
        throw new Error('no publish branch conflict')
      }
      throw new Error(`unexpected git command: ${command.join(' ')}`)
    })
  }

  async function reconcileWithToken(runtime: OrcaRuntimeService, token: string): Promise<void> {
    await runtime.reconcileWorktreeBaseStatus({
      repoId: TEST_REPO_ID,
      repoPath: TEST_REPO_PATH,
      worktreeId: TEST_WORKTREE_ID,
      base: remoteTrackingBase,
      branchName: 'feature',
      createdBaseSha: 'created-base-sha',
      token,
      fetchPromise: Promise.resolve({ ok: true })
    })
  }

  it('emits drift without mutating when the fetched base fast-forwards created HEAD', async () => {
    const { runtime, worktreeBaseStatus } = createReconcileRuntime()
    const token = runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    const gitSpy = mockReconcileGit({})
    try {
      await reconcileWithToken(runtime, token)

      expect(gitSpy).not.toHaveBeenCalledWith(['reset', '--hard', 'new-base-sha'], {
        cwd: TEST_WORKTREE_PATH
      })
      expect(worktreeBaseStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'drift',
          behind: 3,
          recentSubjects: ['base commit 3', 'base commit 2']
        })
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('emits current when the fetched base still matches created HEAD', async () => {
    const { runtime, worktreeBaseStatus } = createReconcileRuntime()
    const token = runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    const gitSpy = mockReconcileGit({ postFetchSha: 'created-base-sha' })
    try {
      await reconcileWithToken(runtime, token)

      expect(worktreeBaseStatus).toHaveBeenCalledWith({
        repoId: TEST_REPO_ID,
        worktreeId: TEST_WORKTREE_ID,
        base: 'origin/main',
        remote: 'origin',
        status: 'current'
      })
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('emits base_changed without mutation when the fetched base rewrote history', async () => {
    const { runtime, worktreeBaseStatus } = createReconcileRuntime()
    const token = runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    const gitSpy = mockReconcileGit({ ancestor: false })
    try {
      await reconcileWithToken(runtime, token)

      expect(gitSpy).not.toHaveBeenCalledWith(['reset', '--hard', 'new-base-sha'], {
        cwd: TEST_WORKTREE_PATH
      })
      expect(worktreeBaseStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'base_changed' })
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('skips stale-token reconciles without mutating or emitting stale status', async () => {
    const stale = createReconcileRuntime()
    const staleToken = stale.runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    stale.runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    const staleGitSpy = mockReconcileGit({})
    try {
      await reconcileWithToken(stale.runtime, staleToken)
      expect(stale.worktreeBaseStatus).not.toHaveBeenCalled()
      expect(staleGitSpy).not.toHaveBeenCalled()
    } finally {
      staleGitSpy.mockRestore()
    }
  })

  it('emits unknown without mutation when fetch fails or the base ref is missing', async () => {
    const fetchFailure = createReconcileRuntime()
    const fetchFailureToken = fetchFailure.runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    await fetchFailure.runtime.reconcileWorktreeBaseStatus({
      repoId: TEST_REPO_ID,
      repoPath: TEST_REPO_PATH,
      worktreeId: TEST_WORKTREE_ID,
      base: remoteTrackingBase,
      branchName: 'feature',
      createdBaseSha: 'created-base-sha',
      token: fetchFailureToken,
      fetchPromise: Promise.resolve({ ok: false, errorKind: 'git_error' })
    })
    expect(fetchFailure.worktreeBaseStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unknown' })
    )

    const missingBase = createReconcileRuntime()
    const missingBaseToken = missingBase.runtime.recordOptimisticReconcileToken(TEST_WORKTREE_ID)
    const gitSpy = mockReconcileGit({ baseRefMissing: true })
    try {
      await reconcileWithToken(missingBase.runtime, missingBaseToken)
      expect(gitSpy).not.toHaveBeenCalledWith(['reset', '--hard', 'new-base-sha'], {
        cwd: TEST_WORKTREE_PATH
      })
      expect(missingBase.worktreeBaseStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'unknown' })
      )
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('invalidates the filesystem-auth cache after CLI worktree creation', async () => {
    // Reproduces: CLI-created worktrees fail with "Access denied: unknown
    // repository or worktree path" because the filesystem-auth cache was
    // not invalidated, so git:branchCompare could not resolve the new path.
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/cli-worktree')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/cli-worktree')
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      {
        path: '/tmp/workspaces/cli-worktree',
        head: 'abc',
        branch: 'cli-worktree',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'cli-worktree'
    })

    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('preserves create-time metadata on later runtime listings when Windows path formatting differs', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      getRepo: (id: string) => runtimeStore.getRepos().find((repo) => repo.id === id),
      getRepos: () => [
        {
          id: 'repo-1',
          path: 'C:\\repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      addRepo: () => {},
      updateRepo: () => undefined as never,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        const existingMeta = metaById[worktreeId]
        const nextMeta: WorktreeMeta = {
          displayName: meta.displayName ?? existingMeta?.displayName ?? '',
          comment: meta.comment ?? existingMeta?.comment ?? '',
          linkedIssue: meta.linkedIssue ?? existingMeta?.linkedIssue ?? null,
          linkedPR: meta.linkedPR ?? existingMeta?.linkedPR ?? null,
          linkedLinearIssue: meta.linkedLinearIssue ?? existingMeta?.linkedLinearIssue ?? null,
          linkedGitLabMR: meta.linkedGitLabMR ?? existingMeta?.linkedGitLabMR ?? null,
          linkedGitLabIssue: meta.linkedGitLabIssue ?? existingMeta?.linkedGitLabIssue ?? null,
          isArchived: meta.isArchived ?? existingMeta?.isArchived ?? false,
          isUnread: meta.isUnread ?? existingMeta?.isUnread ?? false,
          isPinned: meta.isPinned ?? existingMeta?.isPinned ?? false,
          sortOrder: meta.sortOrder ?? existingMeta?.sortOrder ?? 0,
          lastActivityAt: meta.lastActivityAt ?? existingMeta?.lastActivityAt ?? 0
        }
        metaById[worktreeId] = nextMeta
        return nextMeta
      },
      removeWorktreeMeta: () => {},
      getGitHubCache: () => undefined as never,
      getSettings: () => ({
        workspaceDir: 'C:\\workspaces',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: 'none',
        branchPrefixCustom: ''
      })
    }
    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\improve-dashboard')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\improve-dashboard')
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: 'C:/workspaces/improve-dashboard',
          head: 'abc',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: 'C:/workspaces/improve-dashboard',
          head: 'abc',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])

    const runtime = new OrcaRuntimeService(runtimeStore)
    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'Improve Dashboard'
    })
    const listed = await runtime.listManagedWorktrees('id:repo-1')

    expect(listed.worktrees).toMatchObject([
      {
        id: 'repo-1::C:/workspaces/improve-dashboard',
        displayName: 'Improve Dashboard'
      }
    ])
  })

  describe('browser page targeting', () => {
    function mockLiveBrowserGuest(): void {
      electronMocks.webContents.fromId.mockReturnValue({
        isDestroyed: () => false
      })
    }

    it('passes explicit page ids through without resolving the current worktree', async () => {
      vi.mocked(listWorktrees).mockClear()
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn().mockResolvedValue({
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      const result = await runtime.browserSnapshot({ page: 'page-1' })

      expect(result.browserPageId).toBe('page-1')
      expect(snapshotMock).toHaveBeenCalledWith(undefined, 'page-1')
      expect(listWorktrees).not.toHaveBeenCalled()
    })

    it('resolves explicit worktree selectors when page ids are also provided', async () => {
      vi.mocked(listWorktrees).mockClear()
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn().mockResolvedValue({
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await runtime.browserSnapshot({
        worktree: 'branch:feature/foo',
        page: 'page-1'
      })

      expect(snapshotMock).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'page-1')
    })

    it('routes tab switch and capture start by explicit page id', async () => {
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const tabSwitchMock = vi.fn().mockResolvedValue({
        switched: 2,
        browserPageId: 'page-2'
      })
      const captureStartMock = vi.fn().mockResolvedValue({
        capturing: true
      })

      runtime.setAgentBrowserBridge({
        tabSwitch: tabSwitchMock,
        captureStart: captureStartMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-2', 2]]))
      } as never)

      await expect(runtime.browserTabSwitch({ page: 'page-2' })).resolves.toEqual({
        switched: 2,
        browserPageId: 'page-2'
      })
      await expect(runtime.browserCaptureStart({ page: 'page-2' })).resolves.toEqual({
        capturing: true
      })
      expect(tabSwitchMock).toHaveBeenCalledWith(undefined, undefined, 'page-2')
      expect(captureStartMock).toHaveBeenCalledWith(undefined, 'page-2')
    })

    it('accepts focus on tab switch without altering bridge args (focus is main-side concern)', async () => {
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const tabSwitchMock = vi.fn().mockResolvedValue({
        switched: 0,
        browserPageId: 'page-1'
      })

      runtime.setAgentBrowserBridge({
        tabSwitch: tabSwitchMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await expect(runtime.browserTabSwitch({ page: 'page-1', focus: true })).resolves.toEqual({
        switched: 0,
        browserPageId: 'page-1'
      })
      // Bridge is unchanged — focus is delivered to the renderer via IPC
      // (notifyRendererBrowserPaneFocus), not threaded through bridge state.
      expect(tabSwitchMock).toHaveBeenCalledWith(undefined, undefined, 'page-1')
    })

    it('does not silently drop invalid explicit worktree selectors for page-targeted commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn()

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await expect(
        runtime.browserSnapshot({
          worktree: 'path:/tmp/missing-worktree',
          page: 'page-1'
        })
      ).rejects.toThrow('selector_not_found')
      expect(snapshotMock).not.toHaveBeenCalled()
    })

    it('does not silently drop invalid explicit worktree selectors for non-page browser commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      const runtime = createRuntime()
      const tabListMock = vi.fn()

      runtime.setAgentBrowserBridge({
        tabList: tabListMock
      } as never)

      await expect(
        runtime.browserTabList({
          worktree: 'path:/tmp/missing-worktree'
        })
      ).rejects.toThrow('selector_not_found')
      expect(tabListMock).not.toHaveBeenCalled()
    })

    it('rejects closing an unknown page id instead of treating it as success', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      mockLiveBrowserGuest()
      const runtime = createRuntime()

      runtime.setAgentBrowserBridge({
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await expect(
        runtime.browserTabClose({
          page: 'missing-page'
        })
      ).rejects.toThrow('Browser page missing-page was not found')
    })

    it('rejects closing a page outside the explicitly scoped worktree', async () => {
      mockLiveBrowserGuest()
      vi.mocked(listWorktrees).mockResolvedValue([
        ...MOCK_GIT_WORKTREES,
        {
          path: '/tmp/worktree-b',
          head: 'def',
          branch: 'feature/bar',
          isBare: false,
          isMainWorktree: false
        }
      ])
      const runtime = createRuntime()
      const getRegisteredTabsMock = vi.fn((worktreeId?: string) =>
        worktreeId === `${TEST_REPO_ID}::/tmp/worktree-b` ? new Map() : new Map([['page-1', 1]])
      )

      runtime.setAgentBrowserBridge({
        getRegisteredTabs: getRegisteredTabsMock
      } as never)

      await expect(
        runtime.browserTabClose({
          page: 'page-1',
          worktree: 'path:/tmp/worktree-b'
        })
      ).rejects.toThrow('Browser page page-1 was not found in this worktree')
      expect(getRegisteredTabsMock).toHaveBeenCalledWith(`${TEST_REPO_ID}::/tmp/worktree-b`)
    })
  })

  describe('removeManagedWorktree PTY teardown (design §4.3)', () => {
    function createProviderStub(
      listProcesses: () => Promise<{ id: string; cwd: string; title: string }[]>
    ): {
      spawn: ReturnType<typeof vi.fn>
      attach: ReturnType<typeof vi.fn>
      write: ReturnType<typeof vi.fn>
      resize: ReturnType<typeof vi.fn>
      shutdown: ReturnType<typeof vi.fn>
      sendSignal: ReturnType<typeof vi.fn>
      getCwd: ReturnType<typeof vi.fn>
      getInitialCwd: ReturnType<typeof vi.fn>
      clearBuffer: ReturnType<typeof vi.fn>
      acknowledgeDataEvent: ReturnType<typeof vi.fn>
      hasChildProcesses: ReturnType<typeof vi.fn>
      getForegroundProcess: ReturnType<typeof vi.fn>
      serialize: ReturnType<typeof vi.fn>
      revive: ReturnType<typeof vi.fn>
      listProcesses: ReturnType<typeof vi.fn>
      getDefaultShell: ReturnType<typeof vi.fn>
      getProfiles: ReturnType<typeof vi.fn>
      onData: ReturnType<typeof vi.fn>
      onReplay: ReturnType<typeof vi.fn>
      onExit: ReturnType<typeof vi.fn>
    } {
      return {
        spawn: vi.fn(),
        attach: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
        sendSignal: vi.fn(),
        getCwd: vi.fn(),
        getInitialCwd: vi.fn(),
        clearBuffer: vi.fn(),
        acknowledgeDataEvent: vi.fn(),
        hasChildProcesses: vi.fn(),
        getForegroundProcess: vi.fn(),
        serialize: vi.fn(),
        revive: vi.fn(),
        listProcesses: vi.fn(listProcesses),
        getDefaultShell: vi.fn(),
        getProfiles: vi.fn(),
        onData: vi.fn().mockReturnValue(() => {}),
        onReplay: vi.fn().mockReturnValue(() => {}),
        onExit: vi.fn().mockReturnValue(() => {})
      }
    }

    it('RPC-initiated delete kills matching PTYs before git', async () => {
      // Seed the runtime with a live leaf whose worktreeId matches the target.
      const killSpy = vi.fn().mockReturnValue(true)
      const localProvider = createProviderStub(async () => [])
      const callOrder: string[] = []
      vi.mocked(assertWorktreeCleanForRemoval).mockImplementation(async () => {
        callOrder.push('preflight')
      })
      vi.mocked(removeWorktree).mockImplementation(async () => {
        callOrder.push('git-removeWorktree')
        return {}
      })

      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => {
          callOrder.push('getLocalProvider')
          return localProvider as never
        }
      })
      runtime.setPtyController({
        write: () => true,
        kill: (id) => {
          callOrder.push(`kill:${id}`)
          return killSpy(id) as boolean
        },
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime, 'pty-1')

      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

      expect(killSpy).toHaveBeenCalledWith('pty-1')
      // The provider-prefix sweep and the git removal must happen AFTER the
      // runtime-graph kill. Git removal must NOT happen before any kill.
      const preflightIdx = callOrder.indexOf('preflight')
      const killIdx = callOrder.indexOf('kill:pty-1')
      const gitIdx = callOrder.indexOf('git-removeWorktree')
      expect(preflightIdx).toBeGreaterThanOrEqual(0)
      expect(killIdx).toBeGreaterThan(preflightIdx)
      expect(killIdx).toBeGreaterThanOrEqual(0)
      expect(gitIdx).toBeGreaterThan(killIdx)
    })

    it('thunk resolves the installed provider lazily, not at construction time', async () => {
      // Simulates the daemon adapter being installed AFTER OrcaRuntimeService
      // construction (setLocalPtyProvider(routedAdapter) in daemon-init).
      // A capture-at-construction refactor would break this test.
      const preDaemonProvider = createProviderStub(async () => [
        { id: '1', cwd: '/tmp', title: 'shell' },
        { id: '2', cwd: '/tmp', title: 'shell' }
      ])
      const postDaemonProvider = createProviderStub(async () => [
        { id: `${TEST_WORKTREE_ID}@@aaaaaaaa`, cwd: '/tmp', title: 'shell' }
      ])
      let currentProvider: ReturnType<typeof createProviderStub> = preDaemonProvider
      const onPtyStopped = vi.fn()

      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => currentProvider as never,
        onPtyStopped
      })
      vi.mocked(removeWorktree).mockResolvedValue({})

      // Simulate daemon-init swapping the provider after construction.
      currentProvider = postDaemonProvider

      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

      // The post-daemon provider's prefix-matching session must have been
      // shut down, proving the thunk resolved lazily at call time.
      expect(postDaemonProvider.shutdown).toHaveBeenCalledWith(`${TEST_WORKTREE_ID}@@aaaaaaaa`, {
        immediate: true
      })
      expect(onPtyStopped).toHaveBeenCalledWith(`${TEST_WORKTREE_ID}@@aaaaaaaa`)
      // The pre-daemon provider must not have been consulted for the kill.
      expect(preDaemonProvider.shutdown).not.toHaveBeenCalled()
    })
  })
})
