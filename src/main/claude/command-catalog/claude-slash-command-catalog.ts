import type { AgentSessionSlashCommand } from '../../../shared/agent-session/agent-session-wire'

// Stream init carries name arrays; control initialization and reloads carry descriptors.
// Plugins can export hundreds of skills each; the count bounds parsing and per-keystroke picker work.
const MAX_COMMANDS = 1024
// The old count bound; these rows are always kept so no catalog shows fewer rows than before.
const ALWAYS_KEPT_COMMANDS = 512
// Subscribe snapshots and frames carry the list beside a history page and queue, so rows past
// ALWAYS_KEPT_COMMANDS stop once serialized rows pass the room a desktop or phone frame leaves.
const MAX_COMMANDS_JSON_BYTES = 512 * 1024
const MAX_NAME_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 200
const MAX_ARGUMENT_HINT_LENGTH = 100

type CommandDetail = Pick<AgentSessionSlashCommand, 'description' | 'argumentHint' | 'builtin'>

function commandName(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.trim() : ''
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && !/\s/u.test(name) ? name : undefined
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  for (const entry of value) {
    if (seen.size >= MAX_COMMANDS) {
      logCatalogCut('names', seen.size, value.length)
      break
    }
    const name = commandName(entry)
    if (name !== undefined) {
      seen.add(name)
    }
  }
  return [...seen]
}

function logCatalogCut(path: string, kept: number, reported: number): void {
  console.debug('[claude-commands] command catalog cut short', { path, kept, reported })
}

function rowText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength) {
    return undefined
  }
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  return collapsed.length > 0 && collapsed.length <= maxLength ? collapsed : undefined
}

function descriptorCatalog(value: unknown): {
  names: string[]
  details: Map<string, CommandDetail>
} {
  const names: string[] = []
  const seen = new Set<string>()
  const details = new Map<string, CommandDetail>()
  const unmarked = new Set<string>()
  if (!Array.isArray(value)) {
    return { names, details }
  }
  for (const entry of value) {
    if (seen.size >= MAX_COMMANDS) {
      logCatalogCut('descriptors', seen.size, value.length)
      break
    }
    if (entry === null || typeof entry !== 'object') {
      continue
    }
    const name = commandName(entry.name)
    if (name === undefined) {
      continue
    }
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
    if (entry.builtin !== true) {
      unmarked.add(name)
    }
    const previous = details.get(name)
    const description = previous?.description ?? rowText(entry.description, MAX_DESCRIPTION_LENGTH)
    const argumentHint =
      previous?.argumentHint ?? rowText(entry.argumentHint, MAX_ARGUMENT_HINT_LENGTH)
    if (description === undefined && argumentHint === undefined) {
      continue
    }
    details.set(name, {
      ...(description === undefined ? {} : { description }),
      ...(argumentHint === undefined ? {} : { argumentHint })
    })
  }
  // A user skill named like a built-in arrives unmarked, so any unmarked namesake withholds the flag.
  for (const name of names) {
    if (!unmarked.has(name)) {
      details.set(name, { ...details.get(name), builtin: true })
    }
  }
  return { names, details }
}

function carriesCommandCatalog(message: Record<string, unknown>): boolean {
  return (
    message.type === 'system' &&
    (message.subtype === 'init' || message.subtype === 'commands_changed') &&
    Array.isArray(message.slash_commands)
  )
}

// Chat also runs terminal-only commands; filtering them makes the menu change after a turn.
export function readClaudeSlashCommands(
  message: Record<string, unknown>
): AgentSessionSlashCommand[] {
  const skills = new Set(names(message.skills))
  return names(message.slash_commands).map((name) => ({
    name,
    kind: skills.has(name) ? ('skill' as const) : ('command' as const)
  }))
}

export class ClaudeSlashCommandCatalog {
  private entries: AgentSessionSlashCommand[] | undefined
  private hasSkillClassification = false
  private launchCwd: string | undefined
  private commandNames = new Set<string>()
  private details = new Map<string, CommandDetail>()

  constructor(initMessage?: Record<string, unknown>, initialization?: unknown) {
    // SessionStart can prove acquisition before the first stream init exists.
    if (
      initialization !== null &&
      typeof initialization === 'object' &&
      'commands' in initialization &&
      Array.isArray(initialization.commands)
    ) {
      const catalog = descriptorCatalog(initialization.commands)
      this.details = catalog.details
      this.entries = this.describe(
        catalog.names.map((name) => ({
          name,
          kind: 'command',
          kindUnspecified: true
        }))
      )
    }
    if (initMessage) {
      this.observe(initMessage)
    }
  }

  get commands(): AgentSessionSlashCommand[] | undefined {
    return this.entries
  }

  // skills follows cwd after cd; slash_commands remains session-wide, so preserve launch-folder kinds.
  private classify(message: Record<string, unknown>): AgentSessionSlashCommand[] {
    const reported = readClaudeSlashCommands(message)
    const cwd = typeof message.cwd === 'string' ? message.cwd : undefined
    this.launchCwd ??= cwd
    if (cwd === undefined || cwd === this.launchCwd) {
      return reported
    }
    const known = new Map(
      (this.entries ?? [])
        .filter((entry) => !entry.kindUnspecified)
        .map((entry) => [entry.name, entry.kind])
    )
    return reported.map((entry) => ({ ...entry, kind: known.get(entry.name) ?? entry.kind }))
  }

  // Name-only frames do not repeat descriptor text; a name reclassified as a skill is no longer built-in.
  private describe(entries: AgentSessionSlashCommand[]): AgentSessionSlashCommand[] {
    const described: AgentSessionSlashCommand[] = []
    let bytes = 2
    for (const entry of entries) {
      const { builtin, ...detail }: CommandDetail = this.details.get(entry.name) ?? {}
      const row = {
        ...entry,
        ...detail,
        ...(builtin && entry.kind === 'command' ? { builtin } : {})
      }
      bytes += Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
      if (described.length >= ALWAYS_KEPT_COMMANDS && bytes > MAX_COMMANDS_JSON_BYTES) {
        logCatalogCut('bytes', described.length, entries.length)
        break
      }
      described.push(row)
    }
    return described
  }

  observe(message: Record<string, unknown>): boolean {
    let next: AgentSessionSlashCommand[]
    if (carriesCommandCatalog(message)) {
      this.hasSkillClassification = true
      next = this.describe(this.classify(message))
      this.commandNames = new Set(
        next.filter((entry) => entry.kind === 'command').map((entry) => entry.name)
      )
    } else if (
      message.type === 'system' &&
      message.subtype === 'commands_changed' &&
      Array.isArray(message.commands)
    ) {
      const catalog = descriptorCatalog(message.commands)
      this.details = catalog.details
      next = this.describe(
        catalog.names.map((name) =>
          this.hasSkillClassification
            ? { name, kind: this.commandNames.has(name) ? 'command' : 'skill' }
            : { name, kind: 'command', kindUnspecified: true }
        )
      )
    } else {
      return false
    }
    if (
      this.entries !== undefined &&
      next.length === this.entries.length &&
      next.every(
        (entry, index) =>
          entry.name === this.entries?.[index]?.name &&
          entry.kind === this.entries?.[index]?.kind &&
          entry.kindUnspecified === this.entries?.[index]?.kindUnspecified &&
          entry.description === this.entries?.[index]?.description &&
          entry.argumentHint === this.entries?.[index]?.argumentHint &&
          entry.builtin === this.entries?.[index]?.builtin
      )
    ) {
      return false
    }
    this.entries = next
    return true
  }
}
