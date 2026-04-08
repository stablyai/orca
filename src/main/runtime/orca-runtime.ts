/* eslint-disable max-lines -- Why: the Orca runtime is the authoritative live control plane for the CLI, so handle validation, selector resolution, wait state, and summaries are kept together to avoid split-brain behavior. */
/* eslint-disable unicorn/no-useless-spread -- Why: waiter sets and handle keys are cloned intentionally before mutation so resolution and rejection can safely remove entries while iterating. */
/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output before returning bounded text to agents. */
import { gitExecFileSync } from '../git/runner'
import { randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import type { CreateWorktreeResult, Repo, WorktreeLocation } from '../../shared/types'
import { isFolderRepo } from '../../shared/repo-kind'
import type {
  RuntimeGraphStatus,
  RuntimeRepoSearchRefs,
  RuntimeTerminalRead,
  RuntimeTerminalSend,
  RuntimeTerminalListResult,
  RuntimeTerminalState,
  RuntimeStatus,
  RuntimeTerminalWait,
  RuntimeWorktreePsSummary,
  RuntimeTerminalShow,
  RuntimeTerminalSummary,
  RuntimeSyncedLeaf,
  RuntimeSyncedTab,
  RuntimeSyncWindowGraph,
  RuntimeWorktreeListResult
} from '../../shared/runtime-types'
import { getPRForBranch } from '../github/client'
import {
  getGitUsername,
  getDefaultBaseRef,
  getBranchConflictKind,
  isGitRepo,
  getRepoName,
  searchBaseRefs
} from '../git/repo'
import { listWorktrees, addWorktree, removeWorktree } from '../git/worktree'
import { createSetupRunnerScript, getEffectiveHooks, runHook } from '../hooks'
import { REPO_COLORS } from '../../shared/constants'
import { listRepoWorktrees } from '../repo-worktrees'
import type { Store } from '../persistence'
import {
  computeBranchName,
  computeWorktreePath,
  formatWorktreeRemovalError,
  isOrphanedWorktreeError,
  mergeWorktree,
  sanitizeWorktreeName,
  shouldSetDisplayName,
  areWorktreePathsEqual
} from '../ipc/worktree-logic'

type RuntimeStore = {
  getRepos: Store['getRepos']
  getRepo: Store['getRepo']
  addRepo: Store['addRepo']
  updateRepo: Store['updateRepo']
  getAllWorktreeMeta: Store['getAllWorktreeMeta']
  getWorktreeMeta: Store['getWorktreeMeta']
  setWorktreeMeta: Store['setWorktreeMeta']
  removeWorktreeMeta: Store['removeWorktreeMeta']
  getSettings(): {
    workspaceDir: string
    nestWorkspaces: boolean
    worktreeLocation: WorktreeLocation
    branchPrefix: string
    branchPrefixCustom: string
  }
}

type RuntimeLeafRecord = RuntimeSyncedLeaf & {
  ptyGeneration: number
  connected: boolean
  writable: boolean
  lastOutputAt: number | null
  lastExitCode: number | null
  tailBuffer: string[]
  tailPartialLine: string
  tailTruncated: boolean
  preview: string
}

type RuntimePtyController = {
  write(ptyId: string, data: string): boolean
  kill(ptyId: string): boolean
}

type RuntimeNotifier = {
  worktreesChanged(repoId: string): void
  reposChanged(): void
  activateWorktree(repoId: string, worktreeId: string, setup?: CreateWorktreeResult['setup']): void
}

type TerminalHandleRecord = {
  handle: string
  runtimeId: string
  rendererGraphEpoch: number
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string | null
  ptyGeneration: number
}

type TerminalWaiter = {
  handle: string
  resolve: (result: RuntimeTerminalWait) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout | null
}

type ResolvedWorktree = {
  id: string
  repoId: string
  path: string
  branch: string
  linkedIssue: number | null
  git: {
    path: string
    head: string
    branch: string
    isBare: boolean
    isMainWorktree: boolean
  }
  displayName: string
  comment: string
}

type ResolvedWorktreeCache = {
  expiresAt: number
  worktrees: ResolvedWorktree[]
}

export class OrcaRuntimeService {
  private readonly runtimeId = randomUUID()
  private readonly startedAt = Date.now()
  private readonly store: RuntimeStore | null
  private rendererGraphEpoch = 0
  private graphStatus: RuntimeGraphStatus = 'unavailable'
  private authoritativeWindowId: number | null = null
  private tabs = new Map<string, RuntimeSyncedTab>()
  private leaves = new Map<string, RuntimeLeafRecord>()
  private handles = new Map<string, TerminalHandleRecord>()
  private handleByLeafKey = new Map<string, string>()
  private waitersByHandle = new Map<string, Set<TerminalWaiter>>()
  private ptyController: RuntimePtyController | null = null
  private notifier: RuntimeNotifier | null = null
  private resolvedWorktreeCache: ResolvedWorktreeCache | null = null

  constructor(store: RuntimeStore | null = null) {
    this.store = store
  }

  getRuntimeId(): string {
    return this.runtimeId
  }

  getStartedAt(): number {
    return this.startedAt
  }

  getStatus(): RuntimeStatus {
    return {
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      graphStatus: this.graphStatus,
      authoritativeWindowId: this.authoritativeWindowId,
      liveTabCount: this.tabs.size,
      liveLeafCount: this.leaves.size
    }
  }

  setPtyController(controller: RuntimePtyController | null): void {
    // Why: CLI terminal writes must go through the main-owned PTY registry
    // instead of tunneling back through renderer IPC, or live handles could
    // drift from the process they are supposed to control during reloads.
    this.ptyController = controller
  }

  setNotifier(notifier: RuntimeNotifier | null): void {
    this.notifier = notifier
  }

  attachWindow(windowId: number): void {
    if (this.authoritativeWindowId === null) {
      this.authoritativeWindowId = windowId
    }
  }

  syncWindowGraph(windowId: number, graph: RuntimeSyncWindowGraph): RuntimeStatus {
    if (this.authoritativeWindowId === null) {
      this.authoritativeWindowId = windowId
    }
    if (windowId !== this.authoritativeWindowId) {
      throw new Error('Runtime graph publisher does not match the authoritative window')
    }

    this.tabs = new Map(graph.tabs.map((tab) => [tab.tabId, tab]))
    const nextLeaves = new Map<string, RuntimeLeafRecord>()

    for (const leaf of graph.leaves) {
      const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
      const existing = this.leaves.get(leafKey)
      const ptyGeneration =
        existing && existing.ptyId !== leaf.ptyId
          ? existing.ptyGeneration + 1
          : (existing?.ptyGeneration ?? 0)

      nextLeaves.set(leafKey, {
        ...leaf,
        ptyGeneration,
        connected: leaf.ptyId !== null,
        writable: this.graphStatus === 'ready' && leaf.ptyId !== null,
        lastOutputAt: existing?.ptyId === leaf.ptyId ? existing.lastOutputAt : null,
        lastExitCode: existing?.ptyId === leaf.ptyId ? existing.lastExitCode : null,
        tailBuffer: existing?.ptyId === leaf.ptyId ? existing.tailBuffer : [],
        tailPartialLine: existing?.ptyId === leaf.ptyId ? existing.tailPartialLine : '',
        tailTruncated: existing?.ptyId === leaf.ptyId ? existing.tailTruncated : false,
        preview: existing?.ptyId === leaf.ptyId ? existing.preview : ''
      })

      if (existing && (existing.ptyId !== leaf.ptyId || existing.ptyGeneration !== ptyGeneration)) {
        this.invalidateLeafHandle(leafKey)
      }
    }

    for (const oldLeafKey of this.leaves.keys()) {
      if (!nextLeaves.has(oldLeafKey)) {
        this.invalidateLeafHandle(oldLeafKey)
      }
    }

    this.leaves = nextLeaves
    this.graphStatus = 'ready'
    this.refreshWritableFlags()
    return this.getStatus()
  }

  onPtySpawned(ptyId: string): void {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId === ptyId) {
        leaf.connected = true
        leaf.writable = this.graphStatus === 'ready'
      }
    }
  }

  onPtyData(ptyId: string, data: string, at: number): void {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== ptyId) {
        continue
      }
      leaf.connected = true
      leaf.writable = this.graphStatus === 'ready'
      leaf.lastOutputAt = at
      const nextTail = appendToTailBuffer(leaf.tailBuffer, leaf.tailPartialLine, data)
      leaf.tailBuffer = nextTail.lines
      leaf.tailPartialLine = nextTail.partialLine
      leaf.tailTruncated = leaf.tailTruncated || nextTail.truncated
      leaf.preview = buildPreview(leaf.tailBuffer, leaf.tailPartialLine)
    }
  }

  onPtyExit(ptyId: string, exitCode: number): void {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== ptyId) {
        continue
      }
      leaf.connected = false
      leaf.writable = false
      leaf.lastExitCode = exitCode
      this.resolveExitWaiters(leaf)
    }
  }

  async listTerminals(
    worktreeSelector?: string,
    limit = DEFAULT_TERMINAL_LIST_LIMIT
  ): Promise<RuntimeTerminalListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const graphEpoch = this.captureReadyGraphEpoch()
    const targetWorktreeId = worktreeSelector
      ? (await this.resolveWorktreeSelector(worktreeSelector)).id
      : null
    const worktreesById = await this.getResolvedWorktreeMap()
    this.assertStableReadyGraph(graphEpoch)

    const terminals: RuntimeTerminalSummary[] = []
    for (const leaf of this.leaves.values()) {
      if (targetWorktreeId && leaf.worktreeId !== targetWorktreeId) {
        continue
      }
      terminals.push(this.buildTerminalSummary(leaf, worktreesById))
    }
    return {
      terminals: terminals.slice(0, limit),
      totalCount: terminals.length,
      truncated: terminals.length > limit
    }
  }

  async showTerminal(handle: string): Promise<RuntimeTerminalShow> {
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktreesById = await this.getResolvedWorktreeMap()
    this.assertStableReadyGraph(graphEpoch)
    const { leaf } = this.getLiveLeafForHandle(handle)
    const summary = this.buildTerminalSummary(leaf, worktreesById)
    return {
      ...summary,
      paneRuntimeId: leaf.paneRuntimeId,
      ptyId: leaf.ptyId,
      rendererGraphEpoch: this.rendererGraphEpoch
    }
  }

  async readTerminal(handle: string): Promise<RuntimeTerminalRead> {
    const { leaf } = this.getLiveLeafForHandle(handle)
    const tail = buildTailLines(leaf.tailBuffer, leaf.tailPartialLine)
    return {
      handle,
      status: getTerminalState(leaf),
      // Why: Orca does not have a truthful main-owned screen model yet,
      // especially for hidden panes. Focused v1 therefore returns the bounded
      // tail lines directly instead of duplicating the same text in a fake
      // screen field that would waste agent tokens.
      tail,
      truncated: leaf.tailTruncated,
      nextCursor: null
    }
  }

  async sendTerminal(
    handle: string,
    action: {
      text?: string
      enter?: boolean
      interrupt?: boolean
    }
  ): Promise<RuntimeTerminalSend> {
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    const payload = buildSendPayload(action)
    if (payload === null) {
      throw new Error('invalid_terminal_send')
    }
    const wrote = this.ptyController?.write(leaf.ptyId, payload) ?? false
    if (!wrote) {
      throw new Error('terminal_not_writable')
    }
    return {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(payload, 'utf8')
    }
  }

  async waitForTerminal(
    handle: string,
    options?: {
      timeoutMs?: number
    }
  ): Promise<RuntimeTerminalWait> {
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (getTerminalState(leaf) === 'exited') {
      return buildTerminalWaitResult(handle, leaf)
    }

    return await new Promise<RuntimeTerminalWait>((resolve, reject) => {
      const waiter: TerminalWaiter = {
        handle,
        resolve,
        reject,
        timeout: null
      }

      if (typeof options?.timeoutMs === 'number' && options.timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          this.removeWaiter(waiter)
          reject(new Error('timeout'))
        }, options.timeoutMs)
      }

      let waiters = this.waitersByHandle.get(handle)
      if (!waiters) {
        waiters = new Set()
        this.waitersByHandle.set(handle, waiters)
      }
      waiters.add(waiter)

      // Why: the handle may go stale or exit in the small gap between the first
      // validation and waiter registration. Re-checking here keeps wait --for
      // exit honest instead of hanging on a terminal that already changed.
      try {
        const live = this.getLiveLeafForHandle(handle)
        if (getTerminalState(live.leaf) === 'exited') {
          this.resolveWaiter(waiter, buildTerminalWaitResult(handle, live.leaf))
        }
      } catch (error) {
        this.removeWaiter(waiter)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async getWorktreePs(limit = DEFAULT_WORKTREE_PS_LIMIT): Promise<{
    worktrees: RuntimeWorktreePsSummary[]
    totalCount: number
    truncated: boolean
  }> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolvedWorktrees = await this.listResolvedWorktrees()
    const repoById = new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
    const summaries = new Map<string, RuntimeWorktreePsSummary>()

    for (const worktree of resolvedWorktrees) {
      const meta =
        this.store?.getWorktreeMeta?.(worktree.id) ?? this.store?.getAllWorktreeMeta()[worktree.id]
      summaries.set(worktree.id, {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        repo: repoById.get(worktree.repoId)?.displayName ?? worktree.repoId,
        path: worktree.path,
        branch: worktree.branch,
        linkedIssue: worktree.linkedIssue,
        unread: meta?.isUnread ?? false,
        liveTerminalCount: 0,
        hasAttachedPty: false,
        lastOutputAt: null,
        preview: ''
      })
    }

    for (const leaf of this.leaves.values()) {
      const summary = summaries.get(leaf.worktreeId)
      if (!summary) {
        continue
      }
      const previousLastOutputAt = summary.lastOutputAt
      summary.liveTerminalCount += 1
      summary.hasAttachedPty = summary.hasAttachedPty || leaf.connected
      summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, leaf.lastOutputAt)
      if (
        leaf.preview &&
        (summary.preview.length === 0 || (leaf.lastOutputAt ?? -1) >= (previousLastOutputAt ?? -1))
      ) {
        summary.preview = leaf.preview
      }
    }

    const sorted = [...summaries.values()].sort(compareWorktreePs)
    return {
      worktrees: sorted.slice(0, limit),
      totalCount: sorted.length,
      truncated: sorted.length > limit
    }
  }

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }

  async addRepo(path: string, kind: 'git' | 'folder' = 'git'): Promise<Repo> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    if (kind === 'git' && !isGitRepo(path)) {
      throw new Error(`Not a valid git repository: ${path}`)
    }

    const existing = this.store.getRepos().find((repo) => repo.path === path)
    if (existing) {
      return existing
    }

    const repo: Repo = {
      id: randomUUID(),
      path,
      displayName: getRepoName(path),
      badgeColor: REPO_COLORS[this.store.getRepos().length % REPO_COLORS.length],
      addedAt: Date.now(),
      kind
    }
    this.store.addRepo(repo)
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return this.store.getRepo(repo.id) ?? repo
  }

  async showRepo(repoSelector: string): Promise<Repo> {
    return await this.resolveRepoSelector(repoSelector)
  }

  async setRepoBaseRef(repoSelector: string, baseRef: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support base refs.')
    }
    const updated = this.store.updateRepo(repo.id, { worktreeBaseRef: baseRef })
    if (!updated) {
      throw new Error('repo_not_found')
    }
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return updated
  }

  async searchRepoRefs(
    repoSelector: string,
    query: string,
    limit = DEFAULT_REPO_SEARCH_REFS_LIMIT
  ): Promise<RuntimeRepoSearchRefs> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const repo = await this.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return {
        refs: [],
        truncated: false
      }
    }
    const refs = await searchBaseRefs(repo.path, query, limit + 1)
    return {
      refs: refs.slice(0, limit),
      truncated: refs.length > limit
    }
  }

  async listManagedWorktrees(
    repoSelector?: string,
    limit = DEFAULT_WORKTREE_LIST_LIMIT
  ): Promise<RuntimeWorktreeListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolved = await this.listResolvedWorktrees()
    const repoId = repoSelector ? (await this.resolveRepoSelector(repoSelector)).id : null
    const worktrees = resolved.filter((worktree) => !repoId || worktree.repoId === repoId)
    return {
      worktrees: worktrees.slice(0, limit),
      totalCount: worktrees.length,
      truncated: worktrees.length > limit
    }
  }

  async showManagedWorktree(worktreeSelector: string) {
    return await this.resolveWorktreeSelector(worktreeSelector)
  }

  async createManagedWorktree(args: {
    repoSelector: string
    name: string
    baseBranch?: string
    linkedIssue?: number | null
    comment?: string
  }): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support creating worktrees.')
    }
    const settings = this.store.getSettings()
    const requestedName = args.name
    const sanitizedName = sanitizeWorktreeName(args.name)
    const username = getGitUsername(repo.path)
    const branchName = computeBranchName(sanitizedName, settings, username)

    const branchConflictKind = await getBranchConflictKind(repo.path, branchName)
    if (branchConflictKind) {
      throw new Error(
        `Branch "${branchName}" already exists ${branchConflictKind === 'local' ? 'locally' : 'on a remote'}.`
      )
    }

    let existingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
    try {
      existingPR = await getPRForBranch(repo.path, branchName)
    } catch {
      // Why: worktree creation should not hard-fail on transient GitHub reachability
      // issues because git state is still the source of truth for whether the
      // worktree can be created locally.
    }
    if (existingPR) {
      throw new Error(`Branch "${branchName}" already has PR #${existingPR.number}.`)
    }

    // computeWorktreePath now handles WSL, in-repo, and external modes
    // internally and runs path-traversal validation against the correct
    // root for each mode — the calling code does not need to know which
    // mode is active.
    const worktreePath = computeWorktreePath(sanitizedName, repo.path, settings)
    const baseBranch = args.baseBranch || repo.worktreeBaseRef || getDefaultBaseRef(repo.path)

    const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
    try {
      gitExecFileSync(['fetch', remote], { cwd: repo.path })
    } catch {
      // Why: matching the editor behavior keeps CLI creation usable offline.
    }

    addWorktree(repo.path, worktreePath, branchName, baseBranch)
    const gitWorktrees = await listWorktrees(repo.path)
    const created = gitWorktrees.find((gw) => areWorktreePathsEqual(gw.path, worktreePath))
    if (!created) {
      throw new Error('Worktree created but not found in listing')
    }

    const worktreeId = `${repo.id}::${created.path}`
    const meta = this.store.setWorktreeMeta(worktreeId, {
      lastActivityAt: Date.now(),
      ...(shouldSetDisplayName(requestedName, branchName, sanitizedName)
        ? { displayName: requestedName }
        : {}),
      ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
      ...(args.comment !== undefined ? { comment: args.comment } : {})
    })
    const worktree = mergeWorktree(repo.id, created, meta)

    let setup: CreateWorktreeResult['setup']
    const hooks = getEffectiveHooks(repo)
    if (hooks?.scripts.setup) {
      if (this.authoritativeWindowId !== null) {
        try {
          // Why: CLI-created worktrees must use the same runner-script path as the
          // renderer create flow so repo-committed `orca.yaml` setup hooks run in
          // the visible first terminal instead of a hidden background shell with
          // different failure and prompt behavior.
          setup = createSetupRunnerScript(repo, worktreePath, hooks.scripts.setup)
        } catch (error) {
          // Why: the git worktree is already real at this point. If runner
          // generation fails, keep creation successful and surface the problem in
          // logs rather than pretending the worktree was never created.
          console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
        }
      } else {
        void runHook('setup', worktreePath, repo).then((result) => {
          if (!result.success) {
            console.error(`[hooks] setup hook failed for ${worktreePath}:`, result.output)
          }
        })
      }
    }

    this.notifier?.worktreesChanged(repo.id)
    // Why: the editor currently creates the first Orca-managed terminal as a
    // renderer-side consequence of activating a worktree. CLI-created
    // worktrees must trigger that same activation path or they will exist on
    // disk without becoming the active workspace in the UI.
    this.notifier?.activateWorktree(repo.id, worktree.id, setup)
    this.invalidateResolvedWorktreeCache()
    return {
      worktree,
      ...(setup ? { setup } : {})
    }
  }

  async updateManagedWorktreeMeta(
    worktreeSelector: string,
    updates: {
      displayName?: string
      linkedIssue?: number | null
      comment?: string
    }
  ) {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const meta = this.store.setWorktreeMeta(worktree.id, {
      ...(updates.displayName !== undefined ? { displayName: updates.displayName } : {}),
      ...(updates.linkedIssue !== undefined ? { linkedIssue: updates.linkedIssue } : {}),
      ...(updates.comment !== undefined ? { comment: updates.comment } : {})
    })
    // Why: unlike renderer-initiated optimistic updates, CLI callers need an
    // explicit push so the editor refreshes metadata changed outside the UI.
    this.invalidateResolvedWorktreeCache()
    this.notifier?.worktreesChanged(worktree.repoId)
    return mergeWorktree(worktree.repoId, worktree.git, meta)
  }

  async removeManagedWorktree(worktreeSelector: string, force = false): Promise<void> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support deleting worktrees.')
    }

    const hooks = getEffectiveHooks(repo)
    if (hooks?.scripts.archive) {
      const result = await runHook('archive', worktree.path, repo)
      if (!result.success) {
        console.error(`[hooks] archive hook failed for ${worktree.path}:`, result.output)
      }
    }

    try {
      await removeWorktree(repo.path, worktree.path, force)
    } catch (error) {
      if (isOrphanedWorktreeError(error)) {
        await rm(worktree.path, { recursive: true, force: true }).catch(() => {})
        this.store.removeWorktreeMeta(worktree.id)
        this.invalidateResolvedWorktreeCache()
        this.notifier?.worktreesChanged(repo.id)
        return
      }
      throw new Error(formatWorktreeRemovalError(error, worktree.path, force))
    }

    this.store.removeWorktreeMeta(worktree.id)
    this.invalidateResolvedWorktreeCache()
    this.notifier?.worktreesChanged(repo.id)
  }

  async stopTerminalsForWorktree(worktreeSelector: string): Promise<{ stopped: number }> {
    // Why: this mutates live PTYs, so the runtime must reject it while the
    // renderer graph is reloading instead of acting on cached leaf ownership.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === worktree.id && leaf.ptyId) {
        ptyIds.add(leaf.ptyId)
      }
    }

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (this.ptyController?.kill(ptyId)) {
        stopped += 1
      }
    }
    return { stopped }
  }

  markRendererReloading(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    if (this.graphStatus !== 'ready') {
      return
    }
    // Why: any renderer reload tears down the published live graph, so live
    // terminal handles must become stale immediately instead of being reused
    // against whatever the renderer rebuilds next.
    this.rendererGraphEpoch += 1
    this.graphStatus = 'reloading'
    this.handles.clear()
    this.handleByLeafKey.clear()
    this.rejectAllWaiters('terminal_handle_stale')
    this.refreshWritableFlags()
  }

  markGraphReady(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    this.graphStatus = 'ready'
    this.refreshWritableFlags()
  }

  markGraphUnavailable(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    // Why: once the authoritative renderer graph disappears, Orca must fail
    // closed for live-terminal operations instead of guessing from old state.
    if (this.graphStatus !== 'unavailable') {
      this.rendererGraphEpoch += 1
    }
    this.graphStatus = 'unavailable'
    this.authoritativeWindowId = null
    this.tabs.clear()
    this.leaves.clear()
    this.handles.clear()
    this.handleByLeafKey.clear()
    this.rejectAllWaiters('terminal_handle_stale')
  }

  private assertGraphReady(): void {
    if (this.graphStatus !== 'ready') {
      throw new Error('runtime_unavailable')
    }
  }

  private captureReadyGraphEpoch(): number {
    this.assertGraphReady()
    return this.rendererGraphEpoch
  }

  private assertStableReadyGraph(expectedGraphEpoch: number): void {
    if (this.graphStatus !== 'ready' || this.rendererGraphEpoch !== expectedGraphEpoch) {
      throw new Error('runtime_unavailable')
    }
  }

  private async resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    const worktrees = await this.listResolvedWorktrees()
    let candidates: ResolvedWorktree[]

    if (selector === 'active') {
      throw new Error('selector_not_found')
    }

    if (selector.startsWith('id:')) {
      candidates = worktrees.filter((worktree) => worktree.id === selector.slice(3))
    } else if (selector.startsWith('path:')) {
      candidates = worktrees.filter((worktree) => worktree.path === selector.slice(5))
    } else if (selector.startsWith('branch:')) {
      const branchSelector = selector.slice(7)
      candidates = worktrees.filter((worktree) =>
        branchSelectorMatches(worktree.branch, branchSelector)
      )
    } else if (selector.startsWith('issue:')) {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.linkedIssue !== null && String(worktree.linkedIssue) === selector.slice(6)
      )
    } else {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.id === selector ||
          worktree.path === selector ||
          branchSelectorMatches(worktree.branch, selector)
      )
    }

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('selector_not_found')
  }

  private async resolveRepoSelector(selector: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('repo_not_found')
    }
    const repos = this.store.getRepos()
    let candidates: Repo[]

    if (selector.startsWith('id:')) {
      candidates = repos.filter((repo) => repo.id === selector.slice(3))
    } else if (selector.startsWith('path:')) {
      candidates = repos.filter((repo) => repo.path === selector.slice(5))
    } else if (selector.startsWith('name:')) {
      candidates = repos.filter((repo) => repo.displayName === selector.slice(5))
    } else {
      candidates = repos.filter(
        (repo) => repo.id === selector || repo.path === selector || repo.displayName === selector
      )
    }

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('repo_not_found')
  }

  private async listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    if (!this.store) {
      return []
    }
    const now = Date.now()
    if (this.resolvedWorktreeCache && this.resolvedWorktreeCache.expiresAt > now) {
      return this.resolvedWorktreeCache.worktrees
    }

    const metaById = this.store.getAllWorktreeMeta()
    const worktrees: ResolvedWorktree[] = []
    for (const repo of this.store.getRepos()) {
      const gitWorktrees = await listRepoWorktrees(repo)
      for (const gitWorktree of gitWorktrees) {
        const worktreeId = `${repo.id}::${gitWorktree.path}`
        const merged = mergeWorktree(repo.id, gitWorktree, metaById[worktreeId], repo.displayName)
        worktrees.push({
          id: merged.id,
          repoId: repo.id,
          path: merged.path,
          branch: merged.branch,
          linkedIssue: metaById[worktreeId]?.linkedIssue ?? null,
          git: {
            path: gitWorktree.path,
            head: gitWorktree.head,
            branch: gitWorktree.branch,
            isBare: gitWorktree.isBare,
            isMainWorktree: gitWorktree.isMainWorktree
          },
          displayName: merged.displayName,
          comment: merged.comment
        })
      }
    }
    // Why: terminal polling can be frequent, but git worktree state is still
    // allowed to change outside Orca. A short TTL avoids shelling out on every
    // read without pretending the cache is authoritative for long.
    this.resolvedWorktreeCache = {
      worktrees,
      expiresAt: now + RESOLVED_WORKTREE_CACHE_TTL_MS
    }
    return worktrees
  }

  private async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return new Map((await this.listResolvedWorktrees()).map((worktree) => [worktree.id, worktree]))
  }

  private invalidateResolvedWorktreeCache(): void {
    this.resolvedWorktreeCache = null
  }

  private buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(leaf.worktreeId)
    const tab = this.tabs.get(leaf.tabId) ?? null

    return {
      handle: this.issueHandle(leaf),
      worktreeId: leaf.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      title: tab?.title ?? null,
      connected: leaf.connected,
      writable: leaf.writable,
      lastOutputAt: leaf.lastOutputAt,
      preview: leaf.preview
    }
  }

  private getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  } {
    this.assertGraphReady()
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      throw new Error('terminal_handle_stale')
    }
    if (record.rendererGraphEpoch !== this.rendererGraphEpoch) {
      throw new Error('terminal_handle_stale')
    }

    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf || leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration) {
      throw new Error('terminal_handle_stale')
    }
    return { record, leaf }
  }

  private issueHandle(leaf: RuntimeLeafRecord): string {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const existingHandle = this.handleByLeafKey.get(leafKey)
    if (existingHandle) {
      const existingRecord = this.handles.get(existingHandle)
      if (
        existingRecord &&
        existingRecord.rendererGraphEpoch === this.rendererGraphEpoch &&
        existingRecord.ptyId === leaf.ptyId &&
        existingRecord.ptyGeneration === leaf.ptyGeneration
      ) {
        return existingHandle
      }
    }

    const handle = `term_${randomUUID()}`
    this.handles.set(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.handleByLeafKey.set(leafKey, handle)
    return handle
  }

  private refreshWritableFlags(): void {
    for (const leaf of this.leaves.values()) {
      leaf.writable = this.graphStatus === 'ready' && leaf.connected && leaf.ptyId !== null
    }
  }

  private invalidateLeafHandle(leafKey: string): void {
    const handle = this.handleByLeafKey.get(leafKey)
    if (!handle) {
      return
    }
    this.handleByLeafKey.delete(leafKey)
    this.handles.delete(handle)
    this.rejectWaitersForHandle(handle, 'terminal_handle_stale')
  }

  private resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    if (!handle) {
      return
    }
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      this.resolveWaiter(waiter, buildTerminalWaitResult(handle, leaf))
    }
  }

  private resolveWaiter(waiter: TerminalWaiter, result: RuntimeTerminalWait): void {
    this.removeWaiter(waiter)
    waiter.resolve(result)
  }

  private rejectWaitersForHandle(handle: string, code: string): void {
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      this.removeWaiter(waiter)
      waiter.reject(new Error(code))
    }
  }

  private rejectAllWaiters(code: string): void {
    for (const handle of [...this.waitersByHandle.keys()]) {
      this.rejectWaitersForHandle(handle, code)
    }
  }

  private removeWaiter(waiter: TerminalWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
    }
    const waiters = this.waitersByHandle.get(waiter.handle)
    if (!waiters) {
      return
    }
    waiters.delete(waiter)
    if (waiters.size === 0) {
      this.waitersByHandle.delete(waiter.handle)
    }
  }

  private getLeafKey(tabId: string, leafId: string): string {
    return `${tabId}::${leafId}`
  }
}

const MAX_TAIL_LINES = 120
const MAX_TAIL_CHARS = 4000
const MAX_PREVIEW_LINES = 6
const MAX_PREVIEW_CHARS = 300
const DEFAULT_REPO_SEARCH_REFS_LIMIT = 25
const DEFAULT_TERMINAL_LIST_LIMIT = 200
const DEFAULT_WORKTREE_LIST_LIMIT = 200
const DEFAULT_WORKTREE_PS_LIMIT = 200
const RESOLVED_WORKTREE_CACHE_TTL_MS = 1000
function buildPreview(lines: string[], partialLine: string): string {
  const previewLines = buildTailLines(lines, partialLine)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_PREVIEW_LINES)
  const preview = previewLines.join('\n')
  return preview.length > MAX_PREVIEW_CHARS
    ? preview.slice(preview.length - MAX_PREVIEW_CHARS)
    : preview
}

function appendToTailBuffer(
  previousLines: string[],
  previousPartialLine: string,
  chunk: string
): {
  lines: string[]
  partialLine: string
  truncated: boolean
} {
  const normalizedChunk = normalizeTerminalChunk(chunk)
  if (normalizedChunk.length === 0) {
    return {
      lines: previousLines,
      partialLine: previousPartialLine,
      truncated: false
    }
  }

  const pieces = `${previousPartialLine}${normalizedChunk}`.split('\n')
  const nextPartialLine = (pieces.pop() ?? '').replace(/[ \t]+$/g, '')
  const nextLines = [...previousLines, ...pieces.map((line) => line.replace(/[ \t]+$/g, ''))]
  let truncated = false

  while (nextLines.length > MAX_TAIL_LINES) {
    nextLines.shift()
    truncated = true
  }

  let totalChars = nextLines.reduce((sum, line) => sum + line.length, 0) + nextPartialLine.length
  while (nextLines.length > 0 && totalChars > MAX_TAIL_CHARS) {
    totalChars -= nextLines.shift()!.length
    truncated = true
  }

  return {
    lines: nextLines,
    partialLine: nextPartialLine.slice(-MAX_TAIL_CHARS),
    truncated
  }
}

function buildTailLines(lines: string[], partialLine: string): string[] {
  return partialLine.length > 0 ? [...lines, partialLine] : lines
}

function getTerminalState(leaf: RuntimeLeafRecord): RuntimeTerminalState {
  if (leaf.connected) {
    return 'running'
  }
  if (leaf.lastExitCode !== null) {
    return 'exited'
  }
  return 'unknown'
}

function buildSendPayload(action: {
  text?: string
  enter?: boolean
  interrupt?: boolean
}): string | null {
  let payload = ''
  if (typeof action.text === 'string' && action.text.length > 0) {
    payload += action.text
  }
  if (action.enter) {
    payload += '\r'
  }
  if (action.interrupt) {
    payload += '\x03'
  }
  return payload.length > 0 ? payload : null
}

function buildTerminalWaitResult(handle: string, leaf: RuntimeLeafRecord): RuntimeTerminalWait {
  return {
    handle,
    condition: 'exit',
    satisfied: true,
    status: getTerminalState(leaf),
    exitCode: leaf.lastExitCode
  }
}

function branchSelectorMatches(branch: string, selector: string): boolean {
  // Why: Git worktree data can report local branches as either `refs/heads/foo`
  // or `foo` depending on which plumbing path produced the record. Orca's
  // branch selectors should accept either form so newly created worktrees stay
  // discoverable without exposing internal ref-shape differences to users.
  return normalizeBranchRef(branch) === normalizeBranchRef(selector)
}

function normalizeBranchRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
}

function normalizeTerminalChunk(chunk: string): string {
  return chunk
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\u0008/g, '')
    .replace(/[^\x09\x0a\x20-\x7e]/g, '')
}

function maxTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return Math.max(left, right)
}

function compareWorktreePs(
  left: RuntimeWorktreePsSummary,
  right: RuntimeWorktreePsSummary
): number {
  const leftLast = left.lastOutputAt ?? -1
  const rightLast = right.lastOutputAt ?? -1
  if (leftLast !== rightLast) {
    return rightLast - leftLast
  }
  if (left.liveTerminalCount !== right.liveTerminalCount) {
    return right.liveTerminalCount - left.liveTerminalCount
  }
  return left.path.localeCompare(right.path)
}
