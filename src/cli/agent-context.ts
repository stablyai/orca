import type { CommandSpec } from './args'
import { effectiveAllowedFlags } from './args'

// Why: serialize the live spec table so agent discovery cannot drift from the
// command surface it describes.

const SCHEMA_VERSION = 1

export type AgentContextCommand = {
  command: string
  path: string[]
  aliases: string[][]
  argumentMode: 'parsed' | 'passthrough'
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
      argumentMode: spec.argumentMode ?? 'parsed',
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
