import { resolve } from 'node:path'
import { enabledServerForLanguage } from '../../shared/language-server-catalog'
import type {
  LanguageServerId,
  LspOpenFailureReason,
  RepoLanguageServerSettings
} from '../../shared/language-server-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { LspPort, LspSessionConfig } from './lsp-session'
import type { ResolvedLspServer } from './lsp-server-command'

export type LspSessionHandle = {
  ready: Promise<void>
  attachPort(port: LspPort): void
  dispose(options?: { force?: boolean }): Promise<void>
}
export type LspAcquireResult =
  | { ok: true; key: string; session: LspSessionHandle }
  | { ok: false; reason: LspOpenFailureReason }

export type LspSessionManagerDeps = {
  getRepo: (repoId: string) => Repo | undefined
  resolveWorktreeRoot: (worktreePath: string) => Promise<string>
  resolveCommand: (
    serverId: LanguageServerId,
    rootPath: string,
    settings: RepoLanguageServerSettings | undefined
  ) => Promise<ResolvedLspServer | null>
  createSession: (config: LspSessionConfig) => LspSessionHandle
  maxSessionsPerServer?: number
  idleShutdownMs?: number
}

type Entry = {
  session: LspSessionHandle
  serverId: LanguageServerId
  repoId: string
  rootPath: string
  worktreePaths: Set<string>
  lastUsed: number
}

const MAX_UNEXPECTED_EXITS = 3
const fail = (reason: LspOpenFailureReason): LspAcquireResult => ({ ok: false, reason })

export class LspSessionManager {
  private readonly sessions = new Map<string, Entry>()
  private readonly unexpectedExits = new Map<string, number>()
  private useCounter = 0
  private generation = 0
  private disposed = false

  constructor(private readonly deps: LspSessionManagerDeps) {}

  async acquire(request: { worktreeId: string; languageId: string }): Promise<LspAcquireResult> {
    const gen = this.generation
    const parsed = splitWorktreeIdForFilesystem(request.worktreeId)
    const repo = parsed ? this.deps.getRepo(parsed.repoId) : undefined
    if (!parsed || !repo) {
      return fail('invalid-worktree')
    }
    if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
      return fail('unsupported-host')
    }
    const serverId = enabledServerForLanguage(repo.languageServers, request.languageId)
    if (!serverId) {
      return fail('disabled')
    }
    const rootPath = await this.deps.resolveWorktreeRoot(parsed.worktreePath).catch(() => null)
    if (this.generation !== gen || this.disposed) {
      return fail('unavailable')
    }
    if (!rootPath) {
      return fail('invalid-worktree')
    }
    const key = `${serverId}\u0000${rootPath}`
    if ((this.unexpectedExits.get(key) ?? 0) >= MAX_UNEXPECTED_EXITS) {
      return fail('unavailable')
    }
    const existing =
      this.sessions.get(key) ?? (await this.createEntry(key, serverId, repo, rootPath, gen))
    if (!existing) {
      return fail('unavailable')
    }
    existing.lastUsed = ++this.useCounter
    existing.worktreePaths.add(resolve(parsed.worktreePath))
    return { ok: true, key, session: existing.session }
  }

  disposeForWorktree(worktreeId: string): void {
    this.generation++
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    if (!parsed) {
      return
    }
    const target = resolve(parsed.worktreePath)
    this.disposeWhere((entry) => entry.rootPath === target || entry.worktreePaths.has(target))
  }

  disposeForRepo(repoId: string): void {
    this.generation++
    // Why: settings changes reset every crash budget; scope per repo if it ever matters.
    this.unexpectedExits.clear()
    this.disposeWhere((entry) => entry.repoId === repoId)
  }

  async disposeAll(options: { force?: boolean } = {}): Promise<void> {
    this.generation++
    this.disposed = true
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(entries.map((entry) => entry.session.dispose(options)))
  }

  private async createEntry(
    key: string,
    serverId: LanguageServerId,
    repo: Repo,
    rootPath: string,
    gen: number
  ): Promise<Entry | null> {
    let resolved: ResolvedLspServer | null
    try {
      resolved = await this.deps.resolveCommand(serverId, rootPath, repo.languageServers)
    } catch {
      return null
    }
    if (this.generation !== gen || this.disposed) {
      return null
    }
    const raced = this.sessions.get(key)
    if (raced || !resolved) {
      return raced ?? null
    }
    if ((this.unexpectedExits.get(key) ?? 0) >= MAX_UNEXPECTED_EXITS) {
      return null
    }
    let session: LspSessionHandle
    try {
      session = this.deps.createSession({
        serverId,
        rootPath,
        command: resolved.command,
        initializationOptions: resolved.initializationOptions,
        idleShutdownMs: this.deps.idleShutdownMs ?? 3 * 60_000,
        onExit: (unexpected) => {
          if (this.sessions.get(key)?.session === session) {
            this.sessions.delete(key)
          }
          if (unexpected) {
            this.unexpectedExits.set(key, (this.unexpectedExits.get(key) ?? 0) + 1)
          }
        }
      })
    } catch {
      return null
    }
    const entry: Entry = {
      session,
      serverId,
      repoId: repo.id,
      rootPath,
      worktreePaths: new Set(),
      lastUsed: 0
    }
    this.sessions.set(key, entry)
    this.evictOverCap(serverId, key)
    return entry
  }

  private evictOverCap(serverId: LanguageServerId, keepKey: string): void {
    const cap = this.deps.maxSessionsPerServer ?? 3
    // Why: LRU across worktrees; thrashes only with >cap worktrees navigated at once.
    const sameServer = [...this.sessions.entries()]
      .filter(([key, entry]) => entry.serverId === serverId && key !== keepKey)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)
    while (sameServer.length + 1 > cap) {
      const [key, entry] = sameServer.shift() ?? []
      if (!key || !entry) {
        return
      }
      this.sessions.delete(key)
      void entry.session.dispose()
    }
  }

  private disposeWhere(predicate: (entry: Entry) => boolean): void {
    for (const [key, entry] of this.sessions) {
      if (predicate(entry)) {
        this.sessions.delete(key)
        void entry.session.dispose()
      }
    }
  }
}
