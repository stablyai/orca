import {
  AGENT_MEMORY_CONFIDENCE_LEVELS,
  AGENT_MEMORY_DEFAULT_LIMIT,
  AGENT_MEMORY_KINDS,
  AGENT_MEMORY_MAX_LIMIT,
  normalizeMemoryTags,
  type AgentMemoryConfidence,
  type AgentMemoryKind,
  type AgentMemorySearchMatch
} from '../agent-memory-record'
import {
  AgentMemoryRepository,
  type RememberAgentMemoryResult,
  type SearchAgentMemoryResult,
  type ShowAgentMemoryResult
} from '../agent-memory-repository'
import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { getOptionalWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return { id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }
}

async function getMemoryWorktreeSelector(ctx: HandlerContext): Promise<string> {
  const explicit = await getOptionalWorktreeSelector(ctx.flags, 'worktree', ctx.cwd, ctx.client)
  if (explicit) {
    return explicit
  }
  if (ctx.client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Remote agent-memory commands require --worktree because the client cwd cannot identify a server workspace.'
    )
  }
  return resolveCurrentWorktreeSelector(ctx.cwd, ctx.client)
}

function memoryKind(flags: Map<string, string | boolean>): AgentMemoryKind {
  const value = getOptionalStringFlag(flags, 'kind') ?? 'fact'
  if (!AGENT_MEMORY_KINDS.includes(value as AgentMemoryKind)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --kind. Use ${AGENT_MEMORY_KINDS.join(', ')}.`
    )
  }
  return value as AgentMemoryKind
}

function optionalMemoryKind(flags: Map<string, string | boolean>): AgentMemoryKind | undefined {
  return flags.has('kind') ? memoryKind(flags) : undefined
}

function memoryConfidence(flags: Map<string, string | boolean>): AgentMemoryConfidence {
  const value = getOptionalStringFlag(flags, 'confidence') ?? 'medium'
  if (!AGENT_MEMORY_CONFIDENCE_LEVELS.includes(value as AgentMemoryConfidence)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --confidence. Use ${AGENT_MEMORY_CONFIDENCE_LEVELS.join(', ')}.`
    )
  }
  return value as AgentMemoryConfidence
}

async function memoryBody(
  flags: Map<string, string | boolean>,
  repository: AgentMemoryRepository
): Promise<string> {
  const body = getOptionalStringFlag(flags, 'body')
  const bodyFile = getOptionalStringFlag(flags, 'body-file')
  if ((body && bodyFile) || (!body && !bodyFile)) {
    throw new RuntimeClientError('invalid_argument', 'Pass exactly one of --body or --body-file.')
  }
  return body ?? repository.readWorkspaceText(bodyFile as string)
}

function formatInit(result: { worktree: string; relativePath: string; created: boolean }): string {
  return result.created
    ? `Initialized agent memory at ${result.relativePath} for ${result.worktree}.`
    : `Agent memory is ready at ${result.relativePath} for ${result.worktree}.`
}

function formatRemember(result: RememberAgentMemoryResult): string {
  return [
    `Remembered ${result.citation} ${result.record.title}`,
    `kind: ${result.record.kind}`,
    `confidence: ${result.record.confidence}`,
    `path: ${result.relativePath}`,
    `sources: ${result.record.sources.join(', ')}`,
    ...(result.record.tags.length > 0 ? [`tags: ${result.record.tags.join(', ')}`] : []),
    ...(result.record.supersedes ? [`supersedes: ${result.record.supersedes}`] : [])
  ].join('\n')
}

function formatMatch(match: AgentMemorySearchMatch): string {
  return [
    `${match.citation} ${match.record.title}`,
    `kind: ${match.record.kind} | confidence: ${match.record.confidence} | score: ${match.score}`,
    `path: ${match.relativePath}`,
    `sources: ${match.record.sources.join(', ')}`,
    ...(match.supersededBy ? [`supersededBy: ${match.supersededBy.join(', ')}`] : []),
    match.snippet
  ].join('\n')
}

function formatSearch(result: SearchAgentMemoryResult): string {
  if (result.matches.length === 0) {
    return `No agent memories matched "${result.query}".`
  }
  return [
    `Found ${result.matches.length} agent memories for "${result.query}".`,
    ...result.matches.map(formatMatch)
  ].join('\n\n')
}

function formatShow(result: ShowAgentMemoryResult): string {
  const { record, supersededBy } = result.status
  return [
    `${result.citation} ${record.title}`,
    `kind: ${record.kind}`,
    `confidence: ${record.confidence}`,
    `createdAt: ${record.createdAt}`,
    `path: ${result.relativePath}`,
    `sources: ${record.sources.join(', ')}`,
    ...(record.tags.length > 0 ? [`tags: ${record.tags.join(', ')}`] : []),
    ...(record.supersedes ? [`supersedes: ${record.supersedes}`] : []),
    ...(supersededBy ? [`supersededBy: ${supersededBy.join(', ')}`] : []),
    '',
    record.body
  ].join('\n')
}

async function repositoryFor(ctx: HandlerContext): Promise<AgentMemoryRepository> {
  return AgentMemoryRepository.connect(ctx.client, await getMemoryWorktreeSelector(ctx))
}

export const AGENT_MEMORY_HANDLERS: Record<string, CommandHandler> = {
  'agent memory init': async (ctx) => {
    const result = await (await repositoryFor(ctx)).initialize()
    printResult(localSuccess(result), ctx.json, formatInit)
  },
  'agent memory remember': async (ctx) => {
    const repository = await repositoryFor(ctx)
    const result = await repository.remember({
      title: getRequiredStringFlag(ctx.flags, 'title'),
      body: await memoryBody(ctx.flags, repository),
      kind: memoryKind(ctx.flags),
      confidence: memoryConfidence(ctx.flags),
      sources: getRepeatedStringFlag(ctx.flags, 'source'),
      tags: normalizeMemoryTags(getRepeatedStringFlag(ctx.flags, 'tag')),
      ...(getOptionalStringFlag(ctx.flags, 'supersedes')
        ? { supersedes: getOptionalStringFlag(ctx.flags, 'supersedes') }
        : {})
    })
    printResult(localSuccess(result), ctx.json, formatRemember)
  },
  'agent memory search': async (ctx) => {
    const limit = getOptionalPositiveIntegerFlag(ctx.flags, 'limit') ?? AGENT_MEMORY_DEFAULT_LIMIT
    if (limit > AGENT_MEMORY_MAX_LIMIT) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--limit cannot exceed ${AGENT_MEMORY_MAX_LIMIT}.`
      )
    }
    const kind = optionalMemoryKind(ctx.flags)
    const tag = getOptionalStringFlag(ctx.flags, 'tag')
    const result = await (
      await repositoryFor(ctx)
    ).search(getRequiredStringFlag(ctx.flags, 'query'), {
      includeSuperseded: ctx.flags.has('include-superseded'),
      limit,
      ...(kind ? { kind } : {}),
      ...(tag ? { tag: normalizeMemoryTags([tag])[0] } : {})
    })
    printResult(localSuccess(result), ctx.json, formatSearch)
  },
  'agent memory show': async (ctx) => {
    const result = await (await repositoryFor(ctx)).show(getRequiredStringFlag(ctx.flags, 'id'))
    printResult(localSuccess(result), ctx.json, formatShow)
  }
}
