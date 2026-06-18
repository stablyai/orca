import type {
  RuntimeAgentSessionForkContextOptions,
  RuntimeAgentSessionForkCreateResult,
  RuntimeAgentSessionForkDiffResult,
  RuntimeAgentSessionForkListResult,
  RuntimeAgentSessionForkRemoveResult,
  RuntimeAgentSessionForkShowResult
} from '../../shared/runtime-types'
import {
  MAX_AGENT_SESSION_FORK_CONTEXT_CHARS,
  MAX_AGENT_SESSION_FORK_TRANSCRIPT_LINES,
  MIN_AGENT_SESSION_FORK_CONTEXT_CHARS,
  type AgentSessionForkFallbackContextSource
} from '../../shared/agent-session-fork'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { getOptionalWorktreeSelector, getRequiredWorktreeSelector } from '../selectors'
import { RuntimeClientError } from '../runtime-client'

type ProviderSessionKey = 'session_id' | 'conversation_id' | 'session_path'

function getProviderSessionKey(flags: Map<string, string | boolean>): ProviderSessionKey {
  const value = getOptionalStringFlag(flags, 'provider-session-key') ?? 'session_id'
  if (value === 'session_id' || value === 'conversation_id' || value === 'session_path') {
    return value
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--provider-session-key must be session_id, conversation_id, or session_path'
  )
}

function getFallbackContextSource(
  flags: Map<string, string | boolean>
): AgentSessionForkFallbackContextSource | undefined {
  const value = getOptionalStringFlag(flags, 'fallback-context')
  if (value === undefined) {
    return undefined
  }
  if (value === 'auto' || value === 'structured' || value === 'transcript') {
    return value
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--fallback-context must be auto, structured, or transcript'
  )
}

function getBoundedPositiveIntegerFlag(args: {
  flags: Map<string, string | boolean>
  name: string
  min: number
  max: number
}): number | undefined {
  const value = getOptionalPositiveIntegerFlag(args.flags, args.name)
  if (value === undefined) {
    return undefined
  }
  if (value < args.min || value > args.max) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${args.name} must be between ${args.min} and ${args.max}`
    )
  }
  return value
}

function getForkContextOptions(
  flags: Map<string, string | boolean>
): RuntimeAgentSessionForkContextOptions | undefined {
  const fallbackContextSource = getFallbackContextSource(flags)
  const maxContextChars = getBoundedPositiveIntegerFlag({
    flags,
    name: 'context-chars',
    min: MIN_AGENT_SESSION_FORK_CONTEXT_CHARS,
    max: MAX_AGENT_SESSION_FORK_CONTEXT_CHARS
  })
  const transcriptLineLimit = getBoundedPositiveIntegerFlag({
    flags,
    name: 'context-lines',
    min: 1,
    max: MAX_AGENT_SESSION_FORK_TRANSCRIPT_LINES
  })
  if (
    fallbackContextSource === undefined &&
    maxContextChars === undefined &&
    transcriptLineLimit === undefined
  ) {
    return undefined
  }
  return {
    ...(fallbackContextSource ? { fallbackContextSource } : {}),
    ...(maxContextChars !== undefined ? { maxContextChars } : {}),
    ...(transcriptLineLimit !== undefined ? { transcriptLineLimit } : {})
  }
}

function hasProviderSessionSourceFlags(flags: Map<string, string | boolean>): boolean {
  return (
    flags.has('worktree') ||
    flags.has('agent') ||
    flags.has('provider-session') ||
    flags.has('provider-session-key')
  )
}

function formatForkCreate(result: RuntimeAgentSessionForkCreateResult): string {
  const delivery = result.fork.contextDelivery
  const lines = [
    `forkId: ${result.fork.id}`,
    `sourceWorktreeId: ${result.fork.sourceWorktreeId}`,
    `targetWorktreeId: ${result.fork.targetWorktreeId}`,
    `workspaceMode: ${result.fork.workspaceMode}`,
    `path: ${result.worktree.path}`,
    `contextDelivery: ${delivery.mode}`,
    `promptDelivery: ${delivery.promptDelivery}`,
    `agent: ${delivery.agent ?? 'default'}`
  ]
  if (result.fork.childWorktreeId) {
    lines.push(`childWorktreeId: ${result.fork.childWorktreeId}`)
  }
  if (result.fork.terminalHandle) {
    lines.push(`terminalHandle: ${result.fork.terminalHandle}`)
  }
  if (result.fork.forkPoint) {
    lines.push(`forkPoint: ${result.fork.forkPoint.id}`)
  }
  if (delivery.mode === 'native-provider') {
    lines.push(`providerSession: ${delivery.providerSession.id}`)
  } else {
    lines.push(`nativeProviderReason: ${delivery.nativeProviderReason}`)
    if (
      delivery.mode === 'structured-message-fallback' ||
      delivery.mode === 'structured-history-fallback'
    ) {
      lines.push(`includedPromptCount: ${delivery.includedPromptCount}`)
    }
  }
  return lines.join('\n')
}

function formatForkList(result: RuntimeAgentSessionForkListResult): string {
  if (result.forks.length === 0) {
    return 'No forks found.'
  }
  const body = result.forks
    .map(
      (fork) =>
        `${fork.id}  parent:${fork.parentWorktreeId}\n${fork.worktree.path}\ncreatedAt: ${new Date(
          fork.createdAt
        ).toISOString()}${fork.forkPoint ? `\nforkPoint: ${fork.forkPoint.id}` : ''}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.forks.length} of ${result.totalCount}`
    : body
}

function formatForkShow(result: RuntimeAgentSessionForkShowResult): string {
  return [
    `forkId: ${result.fork.id}`,
    `worktreeId: ${result.fork.worktreeId}`,
    `parentWorktreeId: ${result.fork.parentWorktreeId}`,
    `createdAt: ${new Date(result.fork.createdAt).toISOString()}`,
    `path: ${result.fork.worktree.path}`,
    `branch: ${result.fork.worktree.branch}`,
    ...(result.fork.forkPoint ? [`forkPoint: ${result.fork.forkPoint.id}`] : [])
  ].join('\n')
}

function formatForkDiff(result: RuntimeAgentSessionForkDiffResult): string {
  const diff = result.diff.trimEnd()
  const untracked = result.untrackedFiles.map((file) => `  ${file}`).join('\n')
  if (diff && untracked) {
    return `${diff}\n\nUntracked files:\n${untracked}`
  }
  if (diff) {
    return diff
  }
  if (untracked) {
    return `No tracked diff found.\n\nUntracked files:\n${untracked}`
  }
  return 'No changes found.'
}

function formatForkRemove(result: RuntimeAgentSessionForkRemoveResult): string {
  return result.removed ? `removed fork: ${result.forkId}` : `fork not removed: ${result.forkId}`
}

export const FORK_HANDLERS: Record<string, CommandHandler> = {
  fork: async ({ flags, client, cwd, json }) => {
    const terminal = getOptionalStringFlag(flags, 'terminal')
    const message = getOptionalStringFlag(flags, 'message')
    const contextOptions = getForkContextOptions(flags)
    const usesProviderSessionSource = hasProviderSessionSourceFlags(flags)
    if (terminal && usesProviderSessionSource) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass either --terminal or --provider-session source flags, not both.'
      )
    }
    const providerSession = usesProviderSessionSource
      ? {
          key: getProviderSessionKey(flags),
          id: getRequiredStringFlag(flags, 'provider-session')
        }
      : undefined
    const result = await client.call<RuntimeAgentSessionForkCreateResult>(
      'fork.create',
      usesProviderSessionSource
        ? {
            worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
            agent: getRequiredStringFlag(flags, 'agent'),
            providerSession,
            ...(message ? { message } : {}),
            name: getOptionalStringFlag(flags, 'name'),
            activate: flags.get('activate') === true,
            noCopyFiles: flags.get('no-copy-files') === true,
            ...contextOptions
          }
        : {
            terminal,
            ...(message ? { message } : {}),
            name: getOptionalStringFlag(flags, 'name'),
            activate: flags.get('activate') === true,
            noCopyFiles: flags.get('no-copy-files') === true,
            ...contextOptions
          },
      { timeoutMs: 10 * 60_000 }
    )
    printResult(result, json, formatForkCreate)
  },
  'fork list': async ({ flags, client, cwd, json }) => {
    const result = await client.call<RuntimeAgentSessionForkListResult>('fork.list', {
      worktree: await getOptionalWorktreeSelector(flags, 'worktree', cwd, client),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, formatForkList)
  },
  'fork show': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeAgentSessionForkShowResult>('fork.show', {
      fork: getRequiredStringFlag(flags, 'fork')
    })
    printResult(result, json, formatForkShow)
  },
  'fork diff': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeAgentSessionForkDiffResult>(
      'fork.diff',
      {
        fork: getRequiredStringFlag(flags, 'fork')
      },
      { timeoutMs: 60_000 }
    )
    printResult(result, json, formatForkDiff)
  },
  'fork rm': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeAgentSessionForkRemoveResult>(
      'fork.rm',
      {
        fork: getRequiredStringFlag(flags, 'fork'),
        force: flags.get('force') === true,
        runHooks: flags.get('run-hooks') === true
      },
      { timeoutMs: 60_000 }
    )
    printResult(result, json, formatForkRemove)
  }
}
