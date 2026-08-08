import { basename, dirname, join } from 'node:path'
import { open, stat } from 'node:fs/promises'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { AgentType } from '../../shared/agent-status-types'
import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../shared/agent-session-context'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'
import { parseClaudeSessionOptionsRecord } from './claude-session-options'
import { parseAgentSessionOptionsRecord } from './codex-session-options'
import { resolveSessionFilePath } from './session-file-resolver'

export { parseClaudeSessionOptionsRecord } from './claude-session-options'
export { parseAgentSessionOptionsRecord } from './codex-session-options'

const CONTEXT_TAIL_BYTES = 4 * 1024 * 1024
const STATUSLINE_CONTEXT_CACHE_LIMIT = 1024
const contextByPaneKey = new Map<string, AgentSessionContextSnapshot>()

type ContextUsage = { usedTokens: number; maxTokens: number | null }
type SessionOptions = {
  model?: string
  effort?: string
  fastMode?: boolean
  recordedAt: number | null
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export function parseAgentSessionContextRecord(
  agent: AgentType,
  line: string
): ContextUsage | null {
  let record: Record<string, unknown> | null
  try {
    record = object(JSON.parse(line))
  } catch {
    return null
  }
  if (!record) {
    return null
  }
  if (agent === 'codex') {
    const payload = object(record.payload)
    const info = payload?.type === 'token_count' ? object(payload.info) : null
    const usage = object(info?.last_token_usage)
    const usedTokens = finiteNonNegative(usage?.total_tokens)
    const maxTokens = finiteNonNegative(info?.model_context_window)
    return usedTokens === null ? null : { usedTokens, maxTokens }
  }
  if (agent === 'grok') {
    const params = object(record.params) ?? record
    const meta = object(params._meta)
    const usedTokens = finiteNonNegative(meta?.totalTokens)
    return usedTokens === null ? null : { usedTokens, maxTokens: null }
  }
  const message = record.type === 'assistant' ? object(record.message) : null
  const usage = object(message?.usage)
  const input = finiteNonNegative(usage?.input_tokens)
  const cacheCreation = finiteNonNegative(usage?.cache_creation_input_tokens)
  const cacheRead = finiteNonNegative(usage?.cache_read_input_tokens)
  if (input === null && cacheCreation === null && cacheRead === null) {
    return null
  }
  return {
    usedTokens: (input ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0),
    maxTokens: null
  }
}

export async function readAgentSessionContext(
  agent: AgentType,
  providerSession: AgentProviderSessionMetadata,
  current: AgentSessionContextSnapshot
): Promise<AgentSessionContextSnapshot> {
  const transcriptPath =
    providerSession.transcriptPath ??
    (await resolveSessionFilePath(agent, providerSession.id).catch(() => null))
  if (!transcriptPath) {
    return current
  }
  const filePath = contextFilePath(agent, transcriptPath)
  let bytes: Buffer
  try {
    const size = (await stat(filePath)).size
    if (size === 0) {
      return current
    }
    const start = Math.max(0, size - CONTEXT_TAIL_BYTES)
    const handle = await open(filePath, 'r')
    try {
      bytes = Buffer.allocUnsafe(size - start)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start)
      bytes = bytes.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return current
  }
  const lines = bytes.toString('utf8').split(/\r?\n/)
  let usage: ContextUsage | null = null
  let options: SessionOptions | null = null
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? ''
    usage ??= parseAgentSessionContextRecord(agent, line)
    const parsedOptions =
      parseAgentSessionOptionsRecord(agent, line) ?? parseClaudeSessionOptionsRecord(agent, line)
    if (parsedOptions) {
      const currentOptions = options
      options = currentOptions
        ? {
            ...parsedOptions,
            ...currentOptions,
            recordedAt: currentOptions.recordedAt ?? parsedOptions.recordedAt
          }
        : parsedOptions
    }
    const reportsFastMode = agent === 'codex' || agent === 'claude' || agent === 'openclaude'
    if (usage && (!reportsFastMode || options?.fastMode !== undefined)) {
      break
    }
  }
  // A dated row older than the last observation must not revert model/effort
  // that reconfiguration or a newer turn already set: options only move forward.
  const optionsFresh =
    options !== null &&
    (current.observedAt === null ||
      (options.recordedAt !== null && options.recordedAt > current.observedAt))
  const fastModeBackfill = options?.fastMode !== undefined && typeof current.fastMode !== 'boolean'
  const optionValues = options
    ? {
        ...(optionsFresh && options.model ? { model: options.model } : {}),
        ...(optionsFresh && options.effort ? { effort: options.effort } : {}),
        ...(optionsFresh || fastModeBackfill
          ? options.fastMode === undefined
            ? {}
            : { fastMode: options.fastMode }
          : {})
      }
    : {}
  if (usage || optionsFresh || fastModeBackfill) {
    const usedTokens = usage?.usedTokens ?? current.usedTokens
    const maxTokens = usage?.maxTokens ?? current.maxTokens
    const usedPercent =
      usedTokens !== null && maxTokens && maxTokens > 0
        ? Math.min(100, (usedTokens / maxTokens) * 100)
        : current.usedPercent
    const compacted =
      usage !== null &&
      (current.compaction === 'requested' || current.compaction === 'running') &&
      current.usedTokens !== null &&
      usage.usedTokens < current.usedTokens
    const observedAt = Date.now()
    return {
      ...current,
      ...optionValues,
      usedTokens,
      maxTokens,
      remainingTokens:
        usedTokens === null || maxTokens === null ? null : Math.max(0, maxTokens - usedTokens),
      usedPercent,
      estimated: undefined,
      source: 'provider',
      observedAt,
      compaction: compacted ? 'completed' : current.compaction,
      compactionUpdatedAt: compacted ? observedAt : current.compactionUpdatedAt,
      error: undefined
    }
  }
  return current
}

export function ingestAgentSessionStatusLine(event: ClaudeStatusLineRateLimits): void {
  if (!event.paneKey || (!event.context && !event.model && !event.effort)) {
    return
  }
  if (!contextByPaneKey.has(event.paneKey)) {
    while (contextByPaneKey.size >= STATUSLINE_CONTEXT_CACHE_LIMIT) {
      const oldest = contextByPaneKey.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      contextByPaneKey.delete(oldest)
    }
  }
  const current = contextByPaneKey.get(event.paneKey) ?? EMPTY_AGENT_SESSION_CONTEXT
  const compacted =
    (current.compaction === 'requested' || current.compaction === 'running') &&
    current.usedTokens !== null &&
    event.context?.usedTokens !== null &&
    event.context?.usedTokens !== undefined &&
    event.context.usedTokens < current.usedTokens
  const observedAt = Date.now()
  contextByPaneKey.set(event.paneKey, {
    ...EMPTY_AGENT_SESSION_CONTEXT,
    ...current,
    ...event.context,
    ...(event.model ? { model: event.model } : {}),
    ...(event.effort ? { effort: event.effort } : {}),
    source: 'statusline',
    observedAt,
    compaction: compacted ? 'completed' : current.compaction,
    compactionUpdatedAt: compacted ? observedAt : current.compactionUpdatedAt
  })
}

export function ingestAgentSessionCompactionHook(event: {
  paneKey: string
  hookEventName?: string
  receivedAt?: number
  model?: string
}): void {
  const compaction =
    event.hookEventName === 'PreCompact'
      ? 'running'
      : event.hookEventName === 'PostCompact'
        ? 'completed'
        : null
  if (!compaction) {
    if (event.model) {
      contextByPaneKey.set(event.paneKey, {
        ...(contextByPaneKey.get(event.paneKey) ?? EMPTY_AGENT_SESSION_CONTEXT),
        model: event.model
      })
    }
    return
  }
  contextByPaneKey.set(event.paneKey, {
    ...(contextByPaneKey.get(event.paneKey) ?? EMPTY_AGENT_SESSION_CONTEXT),
    ...(event.model ? { model: event.model } : {}),
    compaction,
    compactionUpdatedAt: event.receivedAt ?? Date.now()
  })
}

export async function readNativeChatSessionContext(args: {
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  paneKey?: string
  current?: AgentSessionContextSnapshot
}): Promise<AgentSessionContextSnapshot> {
  const cached = args.paneKey ? contextByPaneKey.get(args.paneKey) : undefined
  const base = args.current ?? cached ?? EMPTY_AGENT_SESSION_CONTEXT
  const compactionCurrent =
    cached?.compactionUpdatedAt &&
    (!base.compactionUpdatedAt || cached.compactionUpdatedAt > base.compactionUpdatedAt)
      ? {
          ...base,
          compaction: cached.compaction,
          compactionUpdatedAt: cached.compactionUpdatedAt
        }
      : base
  const current = {
    ...compactionCurrent,
    ...(cached?.model ? { model: cached.model } : {}),
    ...(cached?.effort ? { effort: cached.effort } : {})
  }
  const next = await readAgentSessionContext(
    args.agent,
    {
      key: 'session_id',
      id: args.sessionId,
      ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {})
    },
    current
  )
  if (args.paneKey) {
    contextByPaneKey.set(args.paneKey, next)
  }
  return next
}

export function clearAgentSessionStatusLineContextForTests(): void {
  contextByPaneKey.clear()
}

export function agentSessionContextUsageEqual(
  left: AgentSessionContextSnapshot,
  right: AgentSessionContextSnapshot
): boolean {
  return (
    left.usedTokens === right.usedTokens &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.fastMode === right.fastMode &&
    left.maxTokens === right.maxTokens &&
    left.remainingTokens === right.remainingTokens &&
    left.usedPercent === right.usedPercent &&
    left.estimated === right.estimated &&
    left.source === right.source &&
    left.compaction === right.compaction &&
    left.compactionUpdatedAt === right.compactionUpdatedAt &&
    left.error === right.error
  )
}

export function contextFilePath(agent: AgentType, transcriptPath: string): string {
  if (agent !== 'grok') {
    return transcriptPath
  }
  const name = basename(transcriptPath)
  return name === 'updates.jsonl' ? transcriptPath : join(dirname(transcriptPath), 'updates.jsonl')
}
