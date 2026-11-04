import { lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentSessionConversationView } from '../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { structuredAgentSessionTabId } from '../../shared/agent-session/view/structured-agent-session-projection'
import type { RuntimeNativeChatFileContext } from '../../shared/runtime-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { parsePaneKey } from '../../shared/stable-pane-id'
import {
  findGrokChatHistoryByCwd,
  findGrokChatHistoryBySessionId,
  GROK_CHAT_HISTORY_FILE,
  isSafeGrokSessionId,
  resolveGrokSessionsDir
} from '../../shared/grok-session-paths'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { isENOENT } from '../ipc/filesystem/access/filesystem-path-containment'
import { needsWslHostResolution } from './host-readable-transcript-path'
import { parseWslPath } from '../wsl/filesystem/unc-path-access'
import { admitTranscriptPath } from './transcript-path-admission'

export type NativeChatMediaPathResolution =
  | { kind: 'matched'; absolutePath: string }
  | { kind: 'ambiguous' }
  | { kind: 'none' }

export type NativeChatMediaPathRequest = {
  worktreeId: string
  worktreePath: string
  executionHostId: ExecutionHostId
  pathText: string
  context: RuntimeNativeChatFileContext
}

type MediaSources = {
  getConversation(id: string): AgentSessionConversationView | null | undefined
  getSessionTabId(id: string): string | null | undefined
  providerRows(tabId: string): readonly AgentStatusIpcPayload[]
}

type GrokMediaSource = {
  sessionsDir: string
  cwd: string
  ids: string[]
  transcriptPath?: string
}

const NONE: NativeChatMediaPathResolution = { kind: 'none' }
const AMBIGUOUS: NativeChatMediaPathResolution = { kind: 'ambiguous' }

function mediaPathParts(pathText: string): string[] | null {
  const parts = pathText.replace(/\\/g, '/').replace(/^\.\//, '').split('/')
  return parts[0] === 'images' &&
    parts.length > 1 &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[:\0]/.test(part))
    ? parts
    : null
}

/** Select session-owned media before workspace fallback; file reads retain their existing access rules. */
export async function resolveNativeChatMediaPath(
  request: NativeChatMediaPathRequest,
  sources: MediaSources
): Promise<NativeChatMediaPathResolution> {
  const parts = mediaPathParts(request.pathText)
  if (
    !parts ||
    request.executionHostId !== 'local' ||
    parseWslPath(request.worktreePath) ||
    needsWslHostResolution(request.worktreePath)
  ) {
    return NONE
  }
  const source = sourceFor(request, sources)
  if (
    !source ||
    !isAbsolute(source.sessionsDir) ||
    needsWslHostResolution(source.sessionsDir) ||
    needsWslHostResolution(source.cwd)
  ) {
    return NONE
  }
  const pending = [...new Set(source.ids)]
  const visited = new Set<string>()
  const matches = new Set<string>()
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index]
    if (!isSafeGrokSessionId(id) || visited.has(id)) {
      continue
    }
    if (visited.size >= MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS) {
      return AMBIGUOUS
    }
    visited.add(id)
    const history =
      (source.transcriptPath && basename(dirname(source.transcriptPath)) === id
        ? (await admitTranscriptPath(source.sessionsDir, source.transcriptPath))?.path
        : null) ??
      (await findGrokChatHistoryByCwd({
        sessionId: id,
        cwd: source.cwd,
        sessionsDir: source.sessionsDir
      })) ??
      (await findGrokChatHistoryBySessionId(source.sessionsDir, id))
    if (!history) {
      continue
    }
    const sessionDir = dirname(history)
    const admitted = await admitTranscriptPath(sessionDir, join(sessionDir, ...parts))
    if (admitted) {
      try {
        if ((await lstat(admitted.path)).isFile()) {
          matches.add(admitted.path)
        }
      } catch (error) {
        if (!isENOENT(error)) {
          throw error
        }
      }
    }
    if (matches.size > 1) {
      return AMBIGUOUS
    }
    // Forks copy history, not image files; their summary retains the provider parent identity.
    const parent = await grokParentSessionId(sessionDir)
    if (parent && !visited.has(parent)) {
      pending.push(parent)
    }
  }
  const [absolutePath] = matches
  return absolutePath ? { kind: 'matched', absolutePath } : NONE
}

function sourceFor(
  request: NativeChatMediaPathRequest,
  sources: MediaSources
): GrokMediaSource | null {
  const { context, worktreeId, worktreePath } = request
  const record = sources.getConversation(context.sessionId)
  if (record) {
    if (
      record.provider !== 'grok' ||
      record.location.workspaceId !== worktreeId ||
      record.location.executionHostId !== request.executionHostId ||
      record.location.wslDistro ||
      !isLegacyAgentSessionAccountHome(record.accountHome) ||
      context.tabId !==
        (sources.getSessionTabId(record.sessionId) ?? structuredAgentSessionTabId(record.sessionId))
    ) {
      return null
    }
    return {
      sessionsDir: join(record.accountHome.path, 'sessions'),
      cwd: record.launchDirectory ?? worktreePath,
      ids: record.providerHandleChain.flatMap(({ handle }) =>
        handle.agent === 'grok' ? [handle.nativeId] : []
      )
    }
  }
  const rows = sources
    .providerRows(context.tabId)
    .filter(
      (row) =>
        row.agentType === 'grok' &&
        !row.connectionId &&
        row.worktreeId === worktreeId &&
        (row.tabId ?? parsePaneKey(row.paneKey)?.tabId) === context.tabId &&
        row.providerSession?.id === context.sessionId
    )
  const row = rows[0]
  if (!row) {
    return null
  }
  if (new Set(rows.map((candidate) => candidate.providerSession?.transcriptPath)).size > 1) {
    return null
  }
  const transcriptPath = row.providerSession?.transcriptPath
  if (
    transcriptPath &&
    (basename(transcriptPath) !== GROK_CHAT_HISTORY_FILE ||
      basename(dirname(transcriptPath)) !== context.sessionId ||
      basename(dirname(dirname(dirname(transcriptPath)))) !== 'sessions' ||
      !isAbsolute(transcriptPath) ||
      needsWslHostResolution(transcriptPath))
  ) {
    return null
  }
  return {
    sessionsDir: transcriptPath
      ? dirname(dirname(dirname(transcriptPath)))
      : resolveGrokSessionsDir(),
    cwd: row.providerSession?.cwd ?? worktreePath,
    ids: [context.sessionId],
    transcriptPath
  }
}

async function grokParentSessionId(sessionDir: string): Promise<string | null> {
  const summary = await admitTranscriptPath(sessionDir, join(sessionDir, 'summary.json'))
  if (!summary) {
    return null
  }
  try {
    const { buffer } = await readNodeFileWithinLimit(summary.path, 16 * 1024 * 1024, {
      regularFileOnly: true
    })
    const value: unknown = JSON.parse(buffer.toString('utf8'))
    return value &&
      typeof value === 'object' &&
      'parent_session_id' in value &&
      typeof value.parent_session_id === 'string' &&
      isSafeGrokSessionId(value.parent_session_id)
      ? value.parent_session_id
      : null
  } catch (error) {
    if (isENOENT(error) || error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}
