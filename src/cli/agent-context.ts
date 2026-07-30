import type { CommandSpec } from './args'
import { effectiveAllowedFlags } from './args'

// Why: serialize the live spec table so agent discovery cannot drift from the
// command surface it describes.

export const AGENT_CONTEXT_SCHEMA_VERSION = 1

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

export function serializeAgentContextCommand(spec: CommandSpec): AgentContextCommand {
  return {
    command: spec.path.join(' '),
    path: spec.path,
    aliases: spec.aliases ?? [],
    argumentMode: spec.argumentMode ?? 'parsed',
    summary: spec.summary,
    usage: spec.usage,
    flags: effectiveAllowedFlags(spec),
    positionalArgs: spec.positionalArgs ?? [],
    examples: spec.examples ?? [],
    notes: spec.notes ?? []
  }
}

export function buildAgentContext(specs: CommandSpec[]): AgentContextSchema {
  const commands = specs
    // Why: expose effective globals as well as command-specific flags.
    .map(serializeAgentContextCommand)
    // Why: deterministic ordering so the JSON diffs cleanly across runs.
    .sort((a, b) => a.command.localeCompare(b.command))
  return {
    schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    commandCount: commands.length,
    commands
  }
}

export function formatAgentContextSummary(schema: AgentContextSchema): string {
  // Why: keep the default (human) output bounded — the full surface is large, so
  // point the reader at --json rather than dumping every command.
  return [
    `${schema.commandCount} commands (schema v${schema.schemaVersion}).`,
    'Discover: `orca agent-context --roots --json`',
    'Search: `orca agent-context --search "<terms>" --json`',
    'Inspect: `orca agent-context --command "<command>" --json`',
    'Full registry: `orca agent-context --json`'
  ].join('\n')
}
