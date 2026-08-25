import {
  AGENT_CONTEXT_SCHEMA_VERSION,
  serializeAgentContextCommand,
  type AgentContextCommand
} from './agent-context'
import {
  normalizeAgentContextQueryText,
  type AgentContextDetail,
  type AgentContextQuery
} from './agent-context-query-request'
import { specPaths, type CommandSpec } from './command-spec'
import { suggestCommands } from './command-suggestion'
import { RuntimeClientError } from './runtime/types'

export const AGENT_CONTEXT_QUERY_SCHEMA_VERSION = 2

type AgentContextView = 'command' | 'prefix' | 'roots' | 'search'

export type AgentContextCommandSummary = Pick<
  AgentContextCommand,
  'aliases' | 'command' | 'path' | 'summary' | 'usage'
> & {
  destructive: boolean
}

export type AgentContextQueryCommand = AgentContextCommand & {
  destructive: boolean
}

export type AgentContextCommandQuerySchema = {
  schemaVersion: number
  registrySchemaVersion: number
  view: Exclude<AgentContextView, 'roots'>
  detail: AgentContextDetail
  registryCommandCount: number
  query: string
  matchCount: number
  returnedCount: number
  truncated: boolean
  commands: (AgentContextCommandSummary | AgentContextQueryCommand)[]
}

export type AgentContextRoot = {
  root: string
  commandCount: number
}

export type AgentContextRootsSchema = {
  schemaVersion: number
  registrySchemaVersion: number
  view: 'roots'
  registryCommandCount: number
  rootCount: number
  roots: AgentContextRoot[]
}

export type AgentContextQuerySchema = AgentContextCommandQuerySchema | AgentContextRootsSchema

export function buildAgentContextQuery(
  specs: CommandSpec[],
  query: AgentContextQuery
): AgentContextQuerySchema {
  if (query.view === 'roots') {
    return buildRootsSchema(specs)
  }
  if (query.view === 'command') {
    const spec = findExactSpec(specs, query.value)
    if (!spec) {
      throw unknownAgentContextCommand(specs, query.value)
    }
    return buildCommandsSchema(specs, query, [spec], 1)
  }
  if (query.view === 'prefix') {
    const matches = findPrefixSpecs(specs, query.value)
    if (matches.length === 0) {
      throw unknownAgentContextPrefix(specs, query.value)
    }
    return buildCommandsSchema(specs, query, matches, matches.length)
  }

  const matches = findSearchSpecs(specs, query.value)
  return buildCommandsSchema(specs, query, matches.slice(0, query.limit), matches.length)
}

export function formatAgentContextQuery(schema: AgentContextQuerySchema): string {
  if (schema.view === 'roots') {
    return schema.roots.map((entry) => `${entry.root}\t${entry.commandCount}`).join('\n')
  }
  if (schema.commands.length === 0) {
    return `No commands matched "${schema.query}".`
  }
  const header =
    schema.returnedCount === schema.matchCount
      ? `${schema.returnedCount} command${schema.returnedCount === 1 ? '' : 's'} matched.`
      : `${schema.returnedCount} of ${schema.matchCount} commands matched.`
  return [
    header,
    ...schema.commands.flatMap((command) => [
      `${command.command}\t${command.summary}`,
      `  ${command.usage}`
    ])
  ].join('\n')
}

function buildRootsSchema(specs: CommandSpec[]): AgentContextRootsSchema {
  const counts = new Map<string, number>()
  for (const spec of specs) {
    const root = spec.path[0]
    counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  const roots = [...counts]
    .map(([root, commandCount]) => ({ root, commandCount }))
    .sort((left, right) => left.root.localeCompare(right.root))
  return {
    schemaVersion: AGENT_CONTEXT_QUERY_SCHEMA_VERSION,
    registrySchemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    view: 'roots',
    registryCommandCount: specs.length,
    rootCount: roots.length,
    roots
  }
}

function buildCommandsSchema(
  specs: CommandSpec[],
  query: Exclude<AgentContextQuery, { view: 'roots' }>,
  returnedSpecs: CommandSpec[],
  matchCount: number
): AgentContextCommandQuerySchema {
  const commands = returnedSpecs.map((spec) => projectCommand(spec, query.detail))
  return {
    schemaVersion: AGENT_CONTEXT_QUERY_SCHEMA_VERSION,
    registrySchemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    view: query.view,
    detail: query.detail,
    registryCommandCount: specs.length,
    query: query.value,
    matchCount,
    returnedCount: commands.length,
    truncated: commands.length < matchCount,
    commands
  }
}

function projectCommand(
  spec: CommandSpec,
  detail: AgentContextDetail
): AgentContextCommandSummary | AgentContextQueryCommand {
  const command = serializeAgentContextCommand(spec)
  if (detail === 'full') {
    return { ...command, destructive: spec.destructive === true }
  }
  const { aliases, path, summary, usage } = command
  return {
    command: command.command,
    path,
    aliases,
    summary,
    usage,
    destructive: spec.destructive === true
  }
}

function findExactSpec(specs: CommandSpec[], value: string): CommandSpec | undefined {
  const expected = normalizeAgentContextQueryText(value)
  return specs.find((spec) =>
    specPaths(spec).some((path) => normalizeAgentContextQueryText(path.join(' ')) === expected)
  )
}

function findPrefixSpecs(specs: CommandSpec[], value: string): CommandSpec[] {
  const prefix = normalizeAgentContextQueryText(value).split(' ')
  return sortSpecs(
    specs.filter((spec) =>
      specPaths(spec).some((path) => {
        const candidate = path.map((part) => part.toLowerCase())
        return prefix.every((part, index) => candidate[index] === part)
      })
    )
  )
}

function findSearchSpecs(specs: CommandSpec[], value: string): CommandSpec[] {
  const query = normalizeAgentContextQueryText(value)
  const terms = query.split(' ')
  return specs
    .map((spec) => ({ spec, rank: searchRank(spec, query, terms) }))
    .filter((entry): entry is { spec: CommandSpec; rank: number } => entry.rank !== null)
    .sort(
      (left, right) =>
        left.rank - right.rank || left.spec.path.join(' ').localeCompare(right.spec.path.join(' '))
    )
    .map((entry) => entry.spec)
}

function searchRank(spec: CommandSpec, query: string, terms: string[]): number | null {
  const paths = specPaths(spec).map((path) => normalizeAgentContextQueryText(path.join(' ')))
  const primary = normalizeAgentContextQueryText(`${spec.summary} ${spec.usage}`)
  const fields = [
    ...paths,
    primary,
    normalizeAgentContextQueryText(spec.allowedFlags.join(' ')),
    normalizeAgentContextQueryText((spec.positionalArgs ?? []).join(' ')),
    normalizeAgentContextQueryText((spec.notes ?? []).join(' ')),
    normalizeAgentContextQueryText((spec.examples ?? []).join(' '))
  ]
  if (!terms.every((term) => fields.some((field) => field.includes(term)))) {
    return null
  }
  if (paths.includes(query)) {
    return 0
  }
  if (paths.some((path) => path.startsWith(`${query} `))) {
    return 1
  }
  if (terms.every((term) => paths.some((path) => path.split(' ').includes(term)))) {
    return 2
  }
  if (terms.every((term) => primary.includes(term))) {
    return 3
  }
  return 4
}

function sortSpecs(specs: CommandSpec[]): CommandSpec[] {
  return [...specs].sort((left, right) => left.path.join(' ').localeCompare(right.path.join(' ')))
}

function unknownAgentContextCommand(specs: CommandSpec[], value: string): RuntimeClientError {
  const suggestions = suggestCommands(specs, normalizeAgentContextQueryText(value).split(' '))
  const nextSteps =
    suggestions.length > 0
      ? [
          `Inspect: ${suggestions
            .map((command) => `orca agent-context --command "${command}" --json`)
            .join(', ')}`
        ]
      : ['Run `orca agent-context --roots --json` or use --search.']
  return new RuntimeClientError('invalid_argument', `Unknown Orca command: ${value}`, {
    suggestions,
    nextSteps
  })
}

function unknownAgentContextPrefix(specs: CommandSpec[], value: string): RuntimeClientError {
  const availableRoots = [...new Set(specs.map((spec) => spec.path[0]))].sort((left, right) =>
    left.localeCompare(right)
  )
  return new RuntimeClientError('invalid_argument', `Unknown Orca command prefix: ${value}`, {
    availableRoots,
    nextSteps: ['Run `orca agent-context --roots --json` or use --search.']
  })
}
