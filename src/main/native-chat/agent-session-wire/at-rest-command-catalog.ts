import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session-wire'
import { requireLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'
import { atRestCommandContextReady } from './at-rest-command-context'

/** How long one scan answers for a folder and account before the next read scans again. The list
 *  changes only when commands, skills or plugins do, and a running chat reports its own. */
export const AT_REST_COMMANDS_TTL_MS = 5 * 60_000
/** A failed scan is due again this soon, so one failure doesn't hide the list for the whole TTL. */
const FAILED_SCAN_RETRY_MS = 10_000
/** A scan still unanswered this long no longer holds the next one off, so a hung folder can't
 *  freeze the menu. At most two run at once, so a folder that stays hung holds no more. */
const SCAN_OVERDUE_MS = 30_000
const MAX_SCANS_IN_FLIGHT = 2
/** How long a client's own `/` read waits for a running scan. Phones ask once per menu and never
 *  hear a later change; well inside their request timeout. */
export const AT_REST_COMMANDS_READ_BUDGET_MS = 10_000

/** One scan's answer. `fromAgent` is the agent's own list, which a fallback never replaces;
 *  `commands` undefined means the agent has no list to give here. */
export type AtRestCommandScan = {
  commands: AgentSessionSlashCommand[] | undefined
  fromAgent: boolean
}

export type AtRestCommandSource = {
  /** Only records this host can scan for: another host's folders are only readable there. */
  accepts: (record: AgentSessionRecord) => boolean
  /** The folder the agent will launch in, and what it lists there. */
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
  /** When the kept answer, or the last failure, landed; a failure lands as an older answer. */
  scannedAt: number
  lastStartedAt: number
  inFlight: number
  /** Numbers each scan, so only an answer newer than the one kept replaces it. */
  started: number
  kept: number
  settled: Set<() => void>
}

/**
 * The `/` surface of a chat whose agent is not running, as its source lists it on the host that
 * runs it, in the folder the chat launches in. Nothing until the first scan lands; `onChange`
 * fires when a scan finds something different.
 */
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

  /** Captures the current owner's answer within one deadline, following retired owners. */
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

  // Why the pin and the account: two floating chats pinned to different folders, or one folder
  // under two accounts, list different skills.
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
      // A rejected fallback still settles the refresh, but cannot supersede the agent's list.
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
          // Due again after the retry delay, leaving room for an older scan's answer meanwhile.
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
