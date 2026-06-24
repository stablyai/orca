import type { CommandSpec } from './args'
import { effectiveAllowedFlags } from './args'

// Why: introspection layer 2 — a machine-readable dump of the whole command
// surface so an agent with no skill loaded can discover the real verbs, aliases,
// and flags in one call. It serializes the live spec table (the single source of
// truth), so the schema never drifts from actual behavior.

const SCHEMA_VERSION = 1

export type AgentContextCommand = {
  command: string
  path: string[]
  aliases: string[][]
  summary: string
  usage: string
  flags: string[]
  positionalArgs: string[]
  examples: string[]
  notes: string[]
}

export type AgentContextSchema = {
  schemaVersion: number
  commandCount: number
  commands: AgentContextCommand[]
}

export function buildAgentContext(specs: CommandSpec[]): AgentContextSchema {
  const commands = specs
    .map((spec) => ({
      command: spec.path.join(' '),
      path: spec.path,
      aliases: spec.aliases ?? [],
      summary: spec.summary,
      usage: spec.usage,
      // Why: the effective accepted set (globals + conditional --page), not just
      // allowedFlags — otherwise agents treat --json/--help as unsupported.
      flags: effectiveAllowedFlags(spec),
      positionalArgs: spec.positionalArgs ?? [],
      examples: spec.examples ?? [],
      notes: spec.notes ?? []
    }))
    // Why: deterministic ordering so the JSON diffs cleanly across runs.
    .sort((a, b) => a.command.localeCompare(b.command))
  return {
    schemaVersion: SCHEMA_VERSION,
    commandCount: commands.length,
    commands
  }
}

export function formatAgentContextSummary(schema: AgentContextSchema): string {
  // Why: keep the default (human) output bounded — the full surface is large, so
  // point the reader at --json rather than dumping every command.
  return [
    `${schema.commandCount} commands (schema v${schema.schemaVersion}).`,
    'Run `orca agent-context --json` for the full machine-readable command schema.'
  ].join('\n')
}
