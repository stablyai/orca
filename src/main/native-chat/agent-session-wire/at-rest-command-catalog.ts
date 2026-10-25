import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session-wire'
import { requireLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'
import { atRestCommandContextReady } from './at-rest-command-context'

/** Running chats supply their own lists; rescan resting folders/accounts after this TTL. */
export const AT_REST_COMMANDS_TTL_MS = 5 * 60_000
/** Retry failures before the full TTL can hide commands. */
const FAILED_SCAN_RETRY_MS = 10_000
/** Overdue scans cannot freeze the menu; cap concurrent hung scans at two. */
const SCAN_OVERDUE_MS = 30_000
const MAX_SCANS_IN_FLIGHT = 2
/** Phones read once per menu; finish within their request timeout. */
export const AT_REST_COMMANDS_READ_BUDGET_MS = 10_000

/** Fallbacks never replace agent-provided lists; undefined means no provider list. */
export type AtRestCommandScan = {
  commands: AgentSessionSlashCommand[] | undefined
  fromAgent: boolean
}

export type AtRestCommandSource = {
  /** Other hosts must scan their own folders. */
  accepts: (record: AgentSessionRecord) => boolean
  scan: (
    record: AgentSessionRecord,
    cwd: string,
    isCurrent: () => boolean
  ) => Promise<AtRestCommandScan>
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  label: string
  now?: () => number
}

type Entry = {
  key: string
  workspaceId: string
  commands?: AgentSessionSlashCommand[]
  fromAgent?: boolean
  /** Failures age the retained answer for earlier retry. */
  scannedAt: number
  lastStartedAt: number
  inFlight: number
  /** Only newer scan results replace retained answers. */
  started: number
  kept: number
  settled: Set<() => void>
}

/** Cache commands from each resting chat’s launch folder; publish changed scan results. */
export class AtRestCommandCatalog implements StructuredAgentSessionAtRestCommands {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private disposed = false

  constructor(private readonly source: AtRestCommandSource) {}

  retireContext = (workspaceId?: string): void => {
    for (const [key, entry] of this.entries) {
      if (workspaceId !== undefined && entry.workspaceId !== workspaceId) {
        continue
      }
      this.entries.delete(key)
      entry.settled.forEach((done) => done())
    }
    queueMicrotask(() => {
      if (!this.disposed) {
        this.listeners.forEach((listener) => listener())
      }
    })
  }

  dispose = (): void => {
    this.disposed = true
    this.retireContext()
    this.listeners.clear()
  }

  read = (record: AgentSessionRecord): AgentSessionSlashCommand[] | undefined =>
    this.readEntry(record)?.commands

  settled = async (record: AgentSessionRecord, budgetMs: number) => {
    const deadline = Date.now() + budgetMs
    for (;;) {
      const entry = this.readEntry(record)
      if (!entry) {
        return undefined
      }
      const remaining = deadline - Date.now()
      if (entry.inFlight > 0 && remaining > 0) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer)
            entry.settled.delete(done)
            resolve()
          }
          const timer = setTimeout(done, remaining)
          entry.settled.add(done)
        })
      }
      if (this.entries.get(entry.key) === entry) {
        return entry.commands
      }
      if (this.disposed || Date.now() >= deadline) {
        return undefined
      }
    }
  }

  onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // Folder pins and accounts can expose different skills.
  private readEntry(record: AgentSessionRecord): Entry | undefined {
    if (this.disposed || !this.source.accepts(record)) {
      return undefined
    }
    const key = JSON.stringify([
      record.provider,
      requireLegacyAgentSessionAccountHome(record.accountHome).path,
      record.location.workspaceId,
      agentSessionPinnedLaunchDirectory(record)
    ])
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        key,
        workspaceId: record.location.workspaceId,
        scannedAt: Number.NEGATIVE_INFINITY,
        lastStartedAt: Number.NEGATIVE_INFINITY,
        inFlight: 0,
        started: 0,
        kept: 0,
        settled: new Set()
      }
      this.entries.set(key, entry)
    }
    const now = this.now()
    const due =
      entry.inFlight === 0
        ? now - entry.scannedAt >= AT_REST_COMMANDS_TTL_MS
        : entry.inFlight < MAX_SCANS_IN_FLIGHT && now - entry.lastStartedAt >= SCAN_OVERDUE_MS
    if (due) {
      this.scanInto(entry, record)
    }
    return entry
  }

  private scanInto(entry: Entry, record: AgentSessionRecord): void {
    const isCurrent = (): boolean => !this.disposed && this.entries.get(entry.key) === entry
    const scan = ++entry.started
    entry.lastStartedAt = this.now()
    entry.inFlight += 1
    const newest = (fromAgent: boolean): boolean => {
      if (!isCurrent() || scan < entry.kept) {
        return false
      }
      entry.scannedAt = this.now()
      // Refresh settles even when fallback cannot supersede an agent-provided list.
      if (entry.fromAgent && !fromAgent) {
        return false
      }
      entry.kept = scan
      return true
    }
    void (async () => {
      await atRestCommandContextReady()
      const cwd =
        agentSessionPinnedLaunchDirectory(record) ??
        (await this.source.resolveWorkspacePath(record.location.workspaceId))
      return isCurrent()
        ? this.source.scan(record, cwd, isCurrent)
        : { commands: undefined, fromAgent: false }
    })()
      .then(
        ({ commands, fromAgent }) => {
          if (!newest(fromAgent)) {
            return
          }
          entry.fromAgent = fromAgent
          if (JSON.stringify(commands) === JSON.stringify(entry.commands)) {
            return
          }
          entry.commands = commands
          for (const listener of this.listeners) {
            listener()
          }
        },
        (error: unknown) => {
          if (!isCurrent()) {
            return
          }
          // Retry soon while allowing older in-flight results to arrive.
          entry.scannedAt = this.now() - AT_REST_COMMANDS_TTL_MS + FAILED_SCAN_RETRY_MS
          console.warn(`[${this.source.label}] reading the at-rest \`/\` commands failed:`, error)
        }
      )
      .finally(() => {
        entry.inFlight -= 1
        if (entry.inFlight === 0) {
          entry.settled.forEach((done) => done())
        }
      })
  }

  private now(): number {
    return this.source.now?.() ?? Date.now()
  }
}
