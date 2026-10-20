import { join } from 'node:path'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  isLegacyAgentSessionAccountHome,
  requireLegacyAgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import { structuredSlashCommands } from '../../shared/structured-agent-session-composer'
import { discoverSkills } from '../skills/discovery'
import { scanClaudeCommandFolders } from './claude-command-folder-scan'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'
import { agentSessionPinnedLaunchDirectory } from '../runtime/agent-session-record-launch-directory'
import type { ClaudeCommandCatalogProbe } from './claude-command-catalog-probe'

/** How long one scan answers for a workspace and account before the next read scans again. The
 *  list changes only when commands, skills or plugins do, and a running chat reports its own. */
export const CLAUDE_AT_REST_COMMANDS_TTL_MS = 5 * 60_000
/** A scan still unanswered this long no longer holds the next one off, so a hung folder can't
 *  freeze the menu. At most two run at once, so a folder that stays hung holds no more. */
const SCAN_OVERDUE_MS = 30_000
const MAX_SCANS_IN_FLIGHT = 2
/** Each probe starts a Claude process, so many workspaces opening at once wait their turn. */
const MAX_PROBES_RUNNING = 2

export type ClaudeAtRestCommandsDeps = {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** Asks Claude itself; absent, or when it fails, the folders are read instead. */
  probe?: ClaudeCommandCatalogProbe
  now?: () => number
  discover?: typeof discoverSkills
}

type Entry = {
  commands?: AgentSessionSlashCommand[]
  /** The kept answer is Claude's own list, which a failed refresh keeps rather than the folders'. */
  fromClaude?: boolean
  /** When the kept answer, or the last failure, landed. */
  scannedAt: number
  lastStartedAt: number
  inFlight: number
  /** Numbers each scan, so only an answer newer than the one kept replaces it. */
  started: number
  kept: number
}

/**
 * The `/` surface of a Claude chat whose Claude is not running, as Claude itself lists it on the
 * host that runs it, in the folder the chat launches in. When Claude can't answer, the folders it
 * reads its own from: the account's and the workspace's command folders and skills, beside the
 * commands the chat's menu always offers. Nothing until the first scan lands; `onChange` fires
 * when a scan finds something different.
 */
export class ClaudeAtRestCommandCatalog {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private readonly probes = new PrioritySemaphore(MAX_PROBES_RUNNING)

  constructor(private readonly deps: ClaudeAtRestCommandsDeps) {}

  read = (record: AgentSessionRecord): AgentSessionSlashCommand[] | undefined => {
    // Another host's folders are only readable there, so this host never answers for them.
    if (
      record.provider !== 'claude' ||
      !supportsClaudeStructuredLocation(record.location) ||
      !isLegacyAgentSessionAccountHome(record.accountHome)
    ) {
      return undefined
    }
    const key = JSON.stringify([record.location.workspaceId, record.accountHome.path])
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        scannedAt: Number.NEGATIVE_INFINITY,
        lastStartedAt: Number.NEGATIVE_INFINITY,
        inFlight: 0,
        started: 0,
        kept: 0
      }
      this.entries.set(key, entry)
    }
    const now = this.now()
    const due =
      entry.inFlight === 0
        ? now - entry.scannedAt >= CLAUDE_AT_REST_COMMANDS_TTL_MS
        : entry.inFlight < MAX_SCANS_IN_FLIGHT && now - entry.lastStartedAt >= SCAN_OVERDUE_MS
    if (due) {
      this.scanInto(entry, record)
    }
    return entry.commands
  }

  onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private scanInto(entry: Entry, record: AgentSessionRecord): void {
    const scan = ++entry.started
    entry.lastStartedAt = this.now()
    entry.inFlight += 1
    const newest = (fromClaude: boolean) => {
      if (scan < entry.kept) {
        return false
      }
      entry.scannedAt = this.now()
      // A rejected fallback still settles the refresh, but cannot supersede Claude's list.
      if (entry.fromClaude && !fromClaude) {
        return false
      }
      entry.kept = scan
      return true
    }
    void this.scan(record)
      .then(
        ({ commands, fromClaude }) => {
          if (!newest(fromClaude)) {
            return
          }
          entry.fromClaude = fromClaude
          if (JSON.stringify(commands) === JSON.stringify(entry.commands)) {
            return
          }
          entry.commands = commands
          for (const listener of this.listeners) {
            listener()
          }
        },
        (error: unknown) => {
          // Waits out the window before trying again, but leaves room for an older scan's answer.
          entry.scannedAt = this.now()
          console.warn('[claude] reading the at-rest `/` commands failed:', error)
        }
      )
      .finally(() => {
        entry.inFlight -= 1
      })
  }

  private async scan(
    record: AgentSessionRecord
  ): Promise<{ commands: AgentSessionSlashCommand[]; fromClaude: boolean }> {
    // The folder Claude will launch in: a floating chat's pin, not the floating setting's current one.
    const cwd =
      agentSessionPinnedLaunchDirectory(record) ??
      (await this.deps.resolveWorkspacePath(record.location.workspaceId))
    const account = requireLegacyAgentSessionAccountHome(record.accountHome).path
    if (this.deps.probe) {
      const release = await this.probes.acquire(0)
      try {
        return {
          commands: await this.deps.probe({ cwd, accountHomePath: account }),
          fromClaude: true
        }
      } catch (error) {
        console.warn('[claude] listing the at-rest `/` commands failed; reading folders:', error)
      } finally {
        release()
      }
    }
    const [custom, discovered] = await Promise.all([
      scanClaudeCommandFolders([join(cwd, '.claude', 'commands'), join(account, 'commands')]),
      (this.deps.discover ?? discoverSkills)({
        repos: [],
        cwd,
        providerRootOverrides: { claude: join(account, 'skills') }
      })
    ])
    // Clients that predate structuredSessionSlashCommands show only this list, so it keeps the host's.
    const builtIn = structuredSlashCommands(['clear', 'compact'], 'claude').map(
      (command): AgentSessionSlashCommand => ({
        name: command.name,
        kind: 'command',
        ...(command.description ? { description: command.description } : {})
      })
    )
    const names = new Set(builtIn.map((command) => command.name))
    const skills = discovered.skills
      .filter((skill) => skill.providers.includes('claude'))
      .map((skill): AgentSessionSlashCommand => ({
        name: skill.name,
        kind: 'skill',
        ...(skill.description ? { description: skill.description } : {})
      }))
    return {
      commands: [...builtIn, ...custom.filter((command) => !names.has(command.name)), ...skills],
      fromClaude: false
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
