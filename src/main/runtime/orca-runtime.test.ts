/* eslint-disable max-lines -- Why: runtime behavior is stateful and cross-cutting, so these tests stay in one file to preserve the end-to-end invariants around handles, waits, and graph sync. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WorktreeLineage, WorktreeMeta } from '../../shared/types'
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
import { OrcaRuntimeService } from './orca-runtime'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'

const {
  MOCK_GIT_WORKTREES,
  addWorktreeMock,
  removeWorktreeMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  sshGitProviders,
  getSshGitProviderMock,
  registerSshGitProviderMock,
  unregisterSshGitProviderMock,
  getActiveMultiplexerMock,
  muxRequestMock,
  invalidateAuthorizedRootsCacheMock,
  createHostedReviewMock,
  getHostedReviewCreationEligibilityMock,
  getPRForBranchMock,
  listGitHubIssuesMock,
  detectInstalledAgentsMock,
  detectRemoteAgentsMock,
  listGitLabMergeRequestsMock,
  listGitLabWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabTodosMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  createGitLabIssueMock,
  updateGitLabIssueMock,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  mergeGitLabMRMock,
  closeGitLabMRMock,
  reopenGitLabMRMock,
  getGlabKnownHostsMock,
  getGitLabWorkItemDetailsMock,
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
    createHostedReviewMock: vi.fn(),
    getHostedReviewCreationEligibilityMock: vi.fn(),
    getPRForBranchMock: vi.fn().mockResolvedValue(null),
    listGitHubIssuesMock: vi.fn(),
    detectInstalledAgentsMock: vi.fn(),
    detectRemoteAgentsMock: vi.fn(),
    listGitLabMergeRequestsMock: vi.fn(),
    listGitLabWorkItemsMock: vi.fn(),
    listGitLabIssuesMock: vi.fn(),
    listGitLabTodosMock: vi.fn(),
    getGitLabProjectRefForRemoteMock: vi.fn(),
    getGitLabWorkItemByProjectRefMock: vi.fn(),
    createGitLabIssueMock: vi.fn(),
    updateGitLabIssueMock: vi.fn(),
    addGitLabIssueCommentMock: vi.fn(),
    addGitLabMRCommentMock: vi.fn(),
    mergeGitLabMRMock: vi.fn(),
    closeGitLabMRMock: vi.fn(),
    reopenGitLabMRMock: vi.fn(),
    getGlabKnownHostsMock: vi.fn(),
    getGitLabWorkItemDetailsMock: vi.fn(),
    getIssueMock: vi.fn(),
    deleteWorktreeHistoryDirMock: vi.fn()
  }
})

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  assertWorktreeCleanForRemoval: vi.fn().mockResolvedValue(undefined),
  addWorktree: addWorktreeMock,
  removeWorktree: removeWorktreeMock
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

vi.mock('../source-control/hosted-review-creation', () => ({
  createHostedReview: createHostedReviewMock,
  getHostedReviewCreationEligibility: getHostedReviewCreationEligibilityMock
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
    listTodos: listGitLabTodosMock,
    getProjectRefForRemote: getGitLabProjectRefForRemoteMock,
    getWorkItemByProjectRef: getGitLabWorkItemByProjectRefMock,
    createIssue: createGitLabIssueMock,
    updateIssue: updateGitLabIssueMock,
    addIssueComment: addGitLabIssueCommentMock,
    addMRComment: addGitLabMRCommentMock,
    mergeMR: mergeGitLabMRMock,
    closeMR: closeGitLabMRMock,
    reopenMR: reopenGitLabMRMock
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
  vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(addWorktree).mockReset()
  vi.mocked(assertWorktreeCleanForRemoval).mockReset()
  vi.mocked(assertWorktreeCleanForRemoval).mockResolvedValue(undefined)
  vi.mocked(removeWorktree).mockReset()
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
  mergeGitLabMRMock.mockReset()
  mergeGitLabMRMock.mockResolvedValue({ ok: true })
  closeGitLabMRMock.mockReset()
  closeGitLabMRMock.mockResolvedValue({ ok: true })
  reopenGitLabMRMock.mockReset()
  reopenGitLabMRMock.mockResolvedValue({ ok: true })
  getGitLabWorkItemDetailsMock.mockReset()
  getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
  getIssueMock.mockReset()
  getIssueMock.mockResolvedValue(null)
})

function syncSinglePty(runtime: OrcaRuntimeService, ptyId: string | null = 'pty-1'): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        title: 'Codex',
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
        paneTitle: null
      }
    ]
  })
}

const TEST_WINDOW_ID = 1
const TEST_REPO_ID = 'repo-1'
const TEST_REPO_PATH = '/tmp/repo'
const TEST_WORKTREE_PATH = '/tmp/worktree-a'
const TEST_WORKTREE_ID = `${TEST_REPO_ID}::${TEST_WORKTREE_PATH}`
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Why: these runtime feature tests only need message-queue semantics; using
// SQLite here makes them fail on unrelated better-sqlite3 native ABI drift.
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

function createStaleRuntimeWorktreeStore(worktreeId: string) {
  const metaById: Record<string, WorktreeMeta> = {
    [worktreeId]: makeWorktreeMeta()
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
    expect(typeof status.protocolVersion).toBe('number')
    expect(typeof status.minCompatibleMobileVersion).toBe('number')
    expect(status.protocolVersion).toBeGreaterThanOrEqual(1)
    expect(status.minCompatibleMobileVersion).toBeGreaterThanOrEqual(0)
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
        false
      )
      expect(result.worktree).toMatchObject({ path: createdWorktree.path })
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
      '/remote/repo/../mobile-feature',
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
    } finally {
      spawnSpy.mockRestore()
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

    await expect(runtime.renameTerminal(handle, 'Worker')).resolves.toMatchObject({
      handle,
      tabId: 'pty:pty-bg',
      title: 'Worker'
    })
    await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
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

  it('resolves message waiters on timeout when no message arrives', async () => {
    const runtime = new OrcaRuntimeService(store)

    const start = Date.now()
    await runtime.waitForMessage('term_abc', { timeoutMs: 100 })
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(500)
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
    expect(activateWorktree).toHaveBeenCalledWith('repo-1', expect.any(String), result.setup)
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

    expect(activateWorktree).toHaveBeenCalledWith('repo-1', expect.any(String), result.setup)
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
        command: 'codex --profile work',
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })

    runtime.onPtyData('pty-startup-draft', '\x1b[?2004h›', Date.now())
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('pty-startup-draft', `\x1b[200~${draftUrl}\x1b[201~`)
    })
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
        command: 'codex',
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
        command: 'codex',
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
    expect(activateWorktree).toHaveBeenCalledWith('repo-1', result.worktree.id, undefined)
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
        command: `claude --prefill '${draftUrl}'`,
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
    mergeGitLabMRMock.mockResolvedValue({ ok: true })
    closeGitLabMRMock.mockResolvedValue({ ok: true })
    reopenGitLabMRMock.mockResolvedValue({ ok: true })
    getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })

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
    await runtime.createGitLabRepoIssue(TEST_REPO_ID, 'New issue', 'Body')
    await runtime.updateGitLabRepoIssue(TEST_REPO_ID, 7, { state: 'closed' })
    await runtime.addGitLabRepoIssueComment(TEST_REPO_ID, 7, 'Looks good')
    await runtime.addGitLabRepoMRComment(TEST_REPO_ID, 8, 'Ship it')
    await runtime.mergeGitLabRepoMR(TEST_REPO_ID, 8, 'squash')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'closed')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'opened')
    await runtime.getGitLabRepoWorkItemDetails(TEST_REPO_ID, 8, 'mr')
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

    expect(activateWorktree).toHaveBeenCalledWith('repo-1', expect.any(String), undefined)
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
    vi.mocked(removeWorktree).mockResolvedValue(undefined)

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(runHook).not.toHaveBeenCalled()
    expect(removeWorktree).toHaveBeenCalledWith(TEST_REPO_PATH, TEST_WORKTREE_PATH, false)
    expect(result.warning).toBe(
      `orca.yaml archive hook skipped for ${TEST_WORKTREE_PATH}; pass --run-hooks to run it.`
    )
  })

  it('coalesces concurrent runtime worktree removals for the same worktree id', async () => {
    const runtime = new OrcaRuntimeService(store)
    const removeStarted = deferred<void>()
    const finishRemoval = deferred<void>()
    vi.mocked(removeWorktree).mockImplementation(async () => {
      removeStarted.resolve()
      await finishRemoval.promise
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
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
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
  })

  it('runs archive hooks for CLI worktree removal when hooks are explicitly enabled', async () => {
    const runtime = new OrcaRuntimeService(store)
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })
    vi.mocked(runHook).mockResolvedValue({ success: true, output: '' })
    vi.mocked(removeWorktree).mockResolvedValue(undefined)

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
    vi.mocked(removeWorktree).mockResolvedValue(undefined)

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
    it('passes explicit page ids through without resolving the current worktree', async () => {
      vi.mocked(listWorktrees).mockClear()
      const runtime = createRuntime()
      const snapshotMock = vi.fn().mockResolvedValue({
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock
      } as never)

      const result = await runtime.browserSnapshot({ page: 'page-1' })

      expect(result.browserPageId).toBe('page-1')
      expect(snapshotMock).toHaveBeenCalledWith(undefined, 'page-1')
      expect(listWorktrees).not.toHaveBeenCalled()
    })

    it('resolves explicit worktree selectors when page ids are also provided', async () => {
      vi.mocked(listWorktrees).mockClear()
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
        captureStart: captureStartMock
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
      const runtime = createRuntime()
      const tabSwitchMock = vi.fn().mockResolvedValue({
        switched: 0,
        browserPageId: 'page-1'
      })

      runtime.setAgentBrowserBridge({ tabSwitch: tabSwitchMock } as never)

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

      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => currentProvider as never
      })
      vi.mocked(removeWorktree).mockResolvedValue(undefined)

      // Simulate daemon-init swapping the provider after construction.
      currentProvider = postDaemonProvider

      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

      // The post-daemon provider's prefix-matching session must have been
      // shut down, proving the thunk resolved lazily at call time.
      expect(postDaemonProvider.shutdown).toHaveBeenCalledWith(`${TEST_WORKTREE_ID}@@aaaaaaaa`, {
        immediate: true
      })
      // The pre-daemon provider must not have been consulted for the kill.
      expect(preDaemonProvider.shutdown).not.toHaveBeenCalled()
    })
  })
})
