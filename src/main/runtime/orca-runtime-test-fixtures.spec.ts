import { expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { OrcaRuntimeService } from './orca-runtime'
import {
  buildAgentPromptPasteBytes,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import { toComparableRelaySshPtyId } from '../../shared/ssh-pty-id'
import {
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock
} from './orca-runtime-test-mocks.spec'

import type {
  FolderWorkspace,
  MessagePriority,
  MessageRow,
  MessageType,
  ProjectGroup,
  RpcRequest,
  TerminalLayoutSnapshot,
  WorkspaceSessionState,
  WorktreeMeta
} from './orca-runtime-test-mocks.spec'
import type { OrchestrationDb } from './orchestration/db'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

type RuntimeService = InstanceType<typeof OrcaRuntimeService>
type HeadlessTerminal = InstanceType<typeof HeadlessEmulator>

function syncSinglePty(
  runtime: RuntimeService,
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

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function makeStatusFrame(index: number, first: boolean): string {
  const pad = '·'.repeat(60)
  const rows = [
    `✻ 执行任务中… (esc to interrupt) [${index}] ${pad}`,
    `  ⎿ 正在分析代码库结构与依赖关系，请稍候… ${pad}`,
    `  ⎿ tokens: ${1000 + index * 137} · elapsed: ${index}s ${pad}`
  ]
  return `${first ? '' : '\x1b[2A'}\r${rows.map((row) => `\x1b[K${row}`).join('\r\n')}\r`
}

async function writeHeadless(emulator: HeadlessTerminal, data: string): Promise<void> {
  await emulator.write(data)
}

function visibleNonEmptyLines(emulator: HeadlessTerminal): string[] {
  return emulator.getVisibleLines().filter((line) => line.length > 0)
}

async function parseHeadlessSnapshotLines(
  snapshot: { data: string; cols: number; rows: number },
  display: { cols: number; rows: number }
): Promise<string[]> {
  const restored = new HeadlessEmulator({ cols: display.cols, rows: display.rows })
  try {
    restored.resize(snapshot.cols, snapshot.rows)
    await writeHeadless(restored, `\x1b[2J\x1b[3J\x1b[H${snapshot.data}`)
    restored.resize(display.cols, display.rows)
    return visibleNonEmptyLines(restored)
  } finally {
    restored.dispose()
  }
}

async function referenceStatusFrameLines(
  spawn: { cols: number; rows: number },
  resized: { cols: number; rows: number }
): Promise<string[]> {
  const truth = new HeadlessEmulator({ cols: spawn.cols, rows: spawn.rows })
  try {
    await writeHeadless(truth, 'user@host % claude\r\n')
    truth.resize(resized.cols, resized.rows)
    for (let index = 0; index < 5; index += 1) {
      await writeHeadless(truth, makeStatusFrame(index, index === 0))
    }
    return visibleNonEmptyLines(truth)
  } finally {
    truth.dispose()
  }
}

const TEST_WINDOW_ID = 1
// The inventory refresh forwards its own budget so a relay cannot outlive it (STA-517).
// These assertions are about which provider scope was asked, so the deadline stays loose.
const LIST_PROVIDER_DEADLINE = expect.objectContaining({ deadlineMs: expect.any(Number) })
const TEST_REPO_ID = 'repo-1'
const TEST_REPO_PATH = '/tmp/repo'
const TEST_WORKTREE_PATH = '/tmp/worktree-a'
const TEST_WORKTREE_ID = `${TEST_REPO_ID}::${TEST_WORKTREE_PATH}`
/** The render gate's hard cap bounds the wait *after* the paste lands, so it carries the
 *  payload's ingest bound on top of the flat 8 s settlement budget. */
function renderGateCapMs(prompt: string): number {
  return (
    8_000 +
    getTerminalPasteIngestMs(
      process.platform,
      Buffer.byteLength(buildAgentPromptPasteBytes(prompt), 'utf8')
    )
  )
}
const TEST_FOLDER_PROJECT_GROUP_ID = 'folder-project-group-1'
const TEST_FOLDER_WORKSPACE_ID = 'folder-workspace-1'
const TEST_FOLDER_WORKSPACE_KEY = `folder:${TEST_FOLDER_WORKSPACE_ID}`
const TEST_FOLDER_WORKSPACE_PATH = '/tmp/platform'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEADLESS_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HEADLESS_SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const HEADLESS_THIRD_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const RESTORED_AUTHORITY_TOKEN = 'restored-authority-secret'
const RESTORED_AUTHORITY_TOKEN_HASH = createHash('sha256')
  .update(RESTORED_AUTHORITY_TOKEN)
  .digest('hex')

function isOriginMainBaseRefProbe(args: string[]): boolean {
  return (
    args[0] === 'rev-parse' &&
    args[1] === '--verify' &&
    (args.includes('origin/main') ||
      args.includes('refs/remotes/origin/main') ||
      args.includes('refs/remotes/origin/main^{commit}'))
  )
}

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

// Why: verbatim cursor-agent 2026.07 idle screen; the matcher keys on the "→" glyph, not the placeholder (which changes after the first turn).
function cursorReadyScreen(): string {
  return [
    'Cursor Agent',
    'v2026.07.09-a3815c0',
    'Tip: Use /plan to plan execution and reach the right outcome faster.',
    '→ Plan, search, build anything',
    'Composer 2.5 Fast                                          Run Everything',
    '~/Documents/projects/AutoGenie · main'
  ].join('\n')
}

function cursorBusyScreen(): string {
  return [
    'Cursor Agent',
    'v2026.07.09-a3815c0',
    '⠰⠳ Thinking  28.61k tokens',
    '→ Plan, search, build anything',
    'Composer 2.5 Fast                                          Run Everything',
    '~/Documents/projects/AutoGenie · main'
  ].join('\n')
}

// Why: these tests only need message-queue semantics; real SQLite would make them fail on unrelated native runtime ABI drift.
class InMemoryOrchestrationMessages {
  private sequence = 0

  private activeCoordinatorRun: { coordinator_handle: string } | null = null

  private messages: MessageRow[] = []

  private runs = new Map<
    string,
    { id: string; coordinator_handle: string | null; coordinator_pane_key: string | null }
  >()

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
      run_id: 'run_test',
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
      delivered_at: null,
      sender_pane_key: null
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

  getUndeliveredUnreadMailboxHandles(): string[] {
    return [
      ...new Set(
        this.messages
          .filter((message) => message.read === 0 && !message.delivered_at)
          .map((message) => message.to_handle)
      )
    ]
  }

  setActiveCoordinatorRun(run: { coordinator_handle: string } | null): void {
    this.activeCoordinatorRun = run
  }

  getActiveCoordinatorRun(): { coordinator_handle: string } | null {
    return this.activeCoordinatorRun
  }

  setRun(run: {
    id: string
    coordinator_handle: string | null
    coordinator_pane_key?: string | null
  }): void {
    this.runs.set(run.id, { coordinator_pane_key: null, ...run })
  }

  getRun(
    id: string
  ):
    | { id: string; coordinator_handle: string | null; coordinator_pane_key: string | null }
    | undefined {
    return this.runs.get(id)
  }

  getCurrentRunForPane(
    paneKey: string
  ):
    | { id: string; coordinator_handle: string | null; coordinator_pane_key: string | null }
    | undefined {
    return [...this.runs.values()].find((run) => run.coordinator_pane_key === paneKey)
  }

  listWorkerTerminalReleaseBacklog(): never[] {
    return []
  }

  hasUndeliveredDirectMessageForRun(runId: string, directHandle: string): boolean {
    return this.messages.some(
      (message) =>
        message.run_id === runId &&
        message.to_handle === directHandle &&
        message.read === 0 &&
        !message.delivered_at
    )
  }

  routeUnreadDirectMessagesToRunMailbox(
    runId: string,
    directHandle: string
  ): { routedCount: number; hasMore: boolean; types: MessageType[] } {
    const routed = this.messages.filter(
      (message) =>
        message.run_id === runId && message.to_handle === directHandle && message.read === 0
    )
    for (const message of routed) {
      message.to_handle = `run:${runId}`
    }
    return {
      routedCount: routed.length,
      hasMore: false,
      types: [...new Set(routed.map((message) => message.type))]
    }
  }

  areUnreadMessages(toHandle: string, ids: string[]): boolean {
    return ids.every((id) =>
      this.messages.some(
        (message) => message.id === id && message.to_handle === toHandle && message.read === 0
      )
    )
  }

  markAsDelivered(ids: string[]): void {
    const deliveredIds = new Set(ids)
    for (const message of this.messages) {
      if (deliveredIds.has(message.id)) {
        message.delivered_at = '1970-01-01 00:00:00'
      }
    }
  }

  markAsUndelivered(ids: string[]): void {
    const releasedIds = new Set(ids)
    for (const message of this.messages) {
      if (releasedIds.has(message.id) && message.read === 0) {
        message.delivered_at = null
      }
    }
  }

  close(): void {}
}

function setInMemoryOrchestrationMessages(
  runtime: RuntimeService,
  db: InMemoryOrchestrationMessages
): void {
  runtime.setOrchestrationDb(db as unknown as OrchestrationDb)
}

function pendingMailPointerRepoints(runtime: RuntimeService): number {
  const internals = runtime as unknown as {
    mailPointerRepointScheduler: { pendingCount: number }
  }
  return internals.mailPointerRepointScheduler.pendingCount
}

function bindSinglePtyRun(db: InMemoryOrchestrationMessages, terminalHandle: string): string {
  db.setRun({
    id: 'run_test',
    coordinator_handle: terminalHandle,
    coordinator_pane_key: 'tab-1:pane:1'
  })
  return 'run:run_test'
}

function expectStablePaneKeyEnv(env: Record<string, string>): string {
  expect(env.ORCA_TAB_ID).toMatch(UUID_RE)
  const leafId = env.ORCA_PANE_KEY?.slice(`${env.ORCA_TAB_ID}:`.length)
  expect(leafId).toMatch(UUID_RE)
  expect(env.ORCA_PANE_KEY).toBe(`${env.ORCA_TAB_ID}:${leafId}`)
  return env.ORCA_PANE_KEY
}

function createRuntime(): RuntimeService {
  return new OrcaRuntimeService(store)
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
  try {
    return await run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
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

function makeWorktreeInfo(
  path: string,
  head = 'head'
): {
  path: string
  head: string
  branch: string
  isBare: boolean
  isMainWorktree: boolean
} {
  return { path, head, branch: 'main', isBare: false, isMainWorktree: path.endsWith('/repo') }
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
  addRetiredWorktreeName: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  mergeRetiredWorktreeNames: () => false,
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
  }),
  getProjects: () => []
}

// Callers pass the pane's APP-form pty id; the lease stores RELAY form, exactly as
// upsertSshRemotePtyLease does through toStoredPtyId. Non-SSH ids pass through untouched.
function createRuntimeWithSshLease(
  ptyId: string,
  tabId: string,
  state: 'expired' | 'terminated' = 'expired',
  marks: { supersededBy?: string; relayIdRecycled?: true } = {}
): RuntimeService {
  const now = Date.now()
  return new OrcaRuntimeService({
    ...store,
    getSshRemotePtyLeases: () => [
      {
        targetId: 'ssh-target',
        ptyId: toComparableRelaySshPtyId('ssh-target', ptyId),
        worktreeId: TEST_WORKTREE_ID,
        tabId,
        leafId: HEADLESS_LEAF_ID,
        state,
        createdAt: now,
        updatedAt: now,
        ...marks
      }
    ]
  })
}

async function createExplicitAgentStatusHarness(options: {
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  inspectProcess?: (ptyId: string) => Promise<PtyProcessInspection>
  confirmForegroundProcess?: (ptyId: string) => Promise<string | null>
  title?: string
}): Promise<{
  runtime: RuntimeService
  handle: string
  syncPty: (ptyId: string | null) => void
}> {
  const leafId = '11111111-1111-4111-8111-111111111111'
  const paneKey = makePaneKey('tab-1', leafId)
  const runtime = new OrcaRuntimeService(store, undefined, {
    getAgentStatusSnapshot: () => [
      {
        paneKey,
        state: 'working',
        prompt: '',
        agentType: 'codex',
        connectionId: null,
        receivedAt: Date.now(),
        stateStartedAt: Date.now(),
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID
      }
    ]
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: options.getForegroundProcess,
    inspectProcess: options.inspectProcess,
    confirmForegroundProcess: options.confirmForegroundProcess
  })
  runtime.attachWindow(1)
  const syncPty = (ptyId: string | null): void => {
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: options.title ?? 'repo terminal',
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
  }
  syncPty('pty-1')
  const [terminal] = (await runtime.listTerminals()).terminals
  return { runtime, handle: terminal.handle, syncPty }
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

function makeRuntimeStoreWithWorkspaceSession(
  initialSession: WorkspaceSessionState,
  // Why: sessions are partitioned by execution host, so the stub must answer for
  // one partition only — a loose stub lets a hardcoded host id pass unnoticed.
  ownerHostId = 'local'
): {
  runtimeStore: typeof store & {
    getWorkspaceSession: (hostId?: string) => WorkspaceSessionState
    setWorkspaceSession: ReturnType<typeof vi.fn>
    flushOrThrow: ReturnType<typeof vi.fn>
    persistPtyBinding: ReturnType<typeof vi.fn>
  }
  getSession: () => WorkspaceSessionState
  setSession: (next: WorkspaceSessionState) => void
} {
  let session = initialSession
  const setSession = (next: WorkspaceSessionState): void => {
    session = next
  }
  const runtimeStore = {
    ...store,
    getWorkspaceSession: (hostId?: string) =>
      hostId === undefined || hostId === ownerHostId ? session : getDefaultWorkspaceSession(),
    setWorkspaceSession: vi.fn(setSession),
    // Headless close is a durable transaction; keep the in-memory fixture's
    // persistence contract equivalent to the production store.
    flushOrThrow: vi.fn(),
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
        return true
      }
    )
  }
  return { runtimeStore, getSession: () => session, setSession }
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

export { HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, HEADLESS_THIRD_LEAF_ID }
export { InMemoryOrchestrationMessages, LIST_PROVIDER_DEADLINE, RESTORED_AUTHORITY_TOKEN }
export { RESTORED_AUTHORITY_TOKEN_HASH, TEST_FOLDER_PROJECT_GROUP_ID, TEST_FOLDER_WORKSPACE_ID }
export { TEST_FOLDER_WORKSPACE_KEY, TEST_FOLDER_WORKSPACE_PATH, TEST_REPO_ID, TEST_REPO_PATH }
export { TEST_WINDOW_ID, TEST_WORKTREE_ID, TEST_WORKTREE_PATH, UUID_RE }
export { antigravityPromptBeforeModelReadyScreen, antigravityReadyScreen, bindSinglePtyRun }
export { createExplicitAgentStatusHarness, createFolderWorkspaceRuntimeStore, createRuntime }
export { createRuntimeWithSshLease, createStaleRuntimeWorktreeStore, cursorBusyScreen }
export { cursorReadyScreen, deferred, expectStablePaneKeyEnv, isOriginMainBaseRefProbe }
export { makeDeferred, makeFolderProjectGroup, makeFolderWorkspace, makeHeadlessTerminalLayout }
export { makeRpcRequest, makeRuntimeStoreWithWorkspaceSession, makeStatusFrame }
export { makeWorkspaceSessionWithHeadlessTerminal, makeWorktreeInfo, makeWorktreeMeta }
export { parseHeadlessSnapshotLines, pendingMailPointerRepoints, referenceStatusFrameLines }
export { renderGateCapMs, setInMemoryOrchestrationMessages, store, syncSinglePty }
export { visibleNonEmptyLines, withPlatform, writeHeadless }
