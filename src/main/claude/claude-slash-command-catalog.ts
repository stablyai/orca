import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'

// The CLI reports its whole `/` surface on `system/init` and republishes it on
// `system/commands_changed`; both frames carry the same three arrays.
const MAX_COMMANDS = 512
const MAX_NAME_LENGTH = 200

function names(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  for (const entry of value) {
    if (seen.size >= MAX_COMMANDS) {
      break
    }
    const name = typeof entry === 'string' ? entry.trim() : ''
    if (name.length > 0 && name.length <= MAX_NAME_LENGTH && !/\s/u.test(name)) {
      seen.add(name)
    }
  }
  return [...seen]
}

function carriesCommandCatalog(message: Record<string, unknown>): boolean {
  return (
    message.type === 'system' &&
    (message.subtype === 'init' || message.subtype === 'commands_changed') &&
    Array.isArray(message.slash_commands)
  )
}

/** What the session reports it can run, minus what it reserves for a terminal UI. */
export function readClaudeSlashCommands(
  message: Record<string, unknown>
): AgentSessionSlashCommand[] {
  // Why: the hide-list exists so a non-terminal UI like chat does not offer a
  // command that only means something inside the CLI's own TUI.
  const hidden = new Set(names(message.terminal_slash_commands))
  const skills = new Set(names(message.skills))
  return names(message.slash_commands)
    .filter((name) => !hidden.has(name))
    .map((name) => ({ name, kind: skills.has(name) ? ('skill' as const) : ('command' as const) }))
}

/** Per-session `/` catalog, seeded from the init frame that proved the session
 *  and refreshed by every later init or `commands_changed` frame. */
export class ClaudeSlashCommandCatalog {
  private entries: AgentSessionSlashCommand[]

  constructor(initMessage?: Record<string, unknown>) {
    this.entries =
      initMessage && carriesCommandCatalog(initMessage) ? readClaudeSlashCommands(initMessage) : []
  }

  get commands(): AgentSessionSlashCommand[] {
    return this.entries
  }

  /** True when this frame replaced the catalog with a different one. */
  observe(message: Record<string, unknown>): boolean {
    if (!carriesCommandCatalog(message)) {
      return false
    }
    const next = readClaudeSlashCommands(message)
    if (
      next.length === this.entries.length &&
      next.every(
        (entry, index) =>
          entry.name === this.entries[index]?.name && entry.kind === this.entries[index]?.kind
      )
    ) {
      return false
    }
    this.entries = next
    return true
  }
}
