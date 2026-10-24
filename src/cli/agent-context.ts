import type { CommandSpec } from './args'
import { effectiveAllowedFlags } from './args'

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
  variadicPositional?: boolean
  repeatableFlags?: string[]
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
    // Hidden commands dispatch but stay off discovery surfaces.
    .filter((spec) => spec.hidden !== true)
    .map((spec) => ({
      command: spec.path.join(' '),
      path: spec.path,
      aliases: spec.aliases ?? [],
      argumentMode: spec.argumentMode ?? 'parsed',
      summary: spec.summary,
      usage: spec.usage,
      // Include globals and conditional flags so discovery matches validation.
      flags: effectiveAllowedFlags(spec),
      positionalArgs: spec.positionalArgs ?? [],
      ...(spec.variadicPositional ? { variadicPositional: true } : {}),
      ...(spec.repeatableFlags ? { repeatableFlags: spec.repeatableFlags } : {}),
      examples: spec.examples ?? [],
      notes: spec.notes ?? []
    }))
    .sort((a, b) => a.command.localeCompare(b.command))
  return {
    schemaVersion: SCHEMA_VERSION,
    commandCount: commands.length,
    commands
  }
}

export function formatAgentContextSummary(schema: AgentContextSchema): string {
  return [
    `${schema.commandCount} commands (schema v${schema.schemaVersion}).`,
    'Run `orca agent-context --json` for the full machine-readable command schema.'
  ].join('\n')
}
