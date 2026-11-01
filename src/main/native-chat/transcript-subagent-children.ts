import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import {
  SUBAGENT_TRANSCRIPT_PREFIX,
  subagentTranscriptsDirFor
} from '../ai-vault/session-scanner-subagent-transcripts'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { BOUNDED_FRAME_CONTENT_BUDGET_BYTES } from './agent-session-wire/agent-session-history-page-bounds'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { splitTranscriptStreamLines } from './transcript-stream-lines'
import { openTranscriptReadStream, wslGatedReaddir } from './wsl-transcript-fs-access'

type NativeChatLineDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLAUDE_CHILD_ID = /^[A-Za-z0-9_-]{1,128}$/
const CHILD_FIT_ATTEMPTS = 8

export type NativeChatChildPage = {
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number
}

/** Reads one child file. Passed in so this module does not import the tail reader. */
export type NativeChatChildTailRead = (
  filePath: string,
  limit: number,
  endOffset: number | undefined,
  signal: AbortSignal | undefined
) => Promise<NativeChatChildPage>

/** Child rows ride along with the parent window so a short tail cannot drop them. */
export function windowNativeChatWithChildren(
  messages: readonly NativeChatMessage[],
  limit: number
): NativeChatMessage[] {
  const own: NativeChatMessage[] = []
  const children: NativeChatMessage[] = []
  for (const message of messages) {
    if (message.agentId) {
      children.push(message)
    } else {
      own.push(message)
    }
  }
  const kept = limit > 0 && own.length > limit ? own.slice(-limit) : own.slice()
  return children.length > 0 ? [...kept, ...children] : kept
}

/**
 * Page one child transcript. Callers leave the parent snapshot on the roster alone.
 */
export async function readNativeChatSubagentPage(args: {
  parentPath: string
  decode: NativeChatLineDecoder
  agentId: string
  limit: number
  beforeOffset?: number
  signal?: AbortSignal
  readTail: NativeChatChildTailRead
}): Promise<NativeChatChildPage | null> {
  const childPath =
    args.decode === decodeClaudeTranscriptLine
      ? claudeChildPath(args.parentPath, args.agentId)
      : args.decode === decodeCodexTranscriptLine
        ? await codexChildPath(args.parentPath, args.agentId, args.signal)
        : null
  if (!childPath || args.limit <= 0) {
    return childPath ? { messages: [], hasMore: false, beforeOffset: 0 } : null
  }
  return readFittedPage(
    childPath,
    args.agentId,
    args.limit,
    args.beforeOffset,
    args.readTail,
    args.signal
  )
}

function claudeChildPath(parentPath: string, agentId: string): string | null {
  if (!CLAUDE_CHILD_ID.test(agentId)) {
    return null
  }
  return join(
    subagentTranscriptsDirFor(parentPath),
    `${SUBAGENT_TRANSCRIPT_PREFIX}${agentId}.jsonl`
  )
}

async function readFittedPage(
  filePath: string,
  agentId: string,
  limit: number,
  beforeOffset: number | undefined,
  readTail: NativeChatChildTailRead,
  signal: AbortSignal | undefined
): Promise<NativeChatChildPage | null> {
  let window = limit
  try {
    let page = await readTail(filePath, window, beforeOffset, signal)
    let messages = stampChildMessages(page.messages, agentId)
    for (
      let attempt = 0;
      attempt < CHILD_FIT_ATTEMPTS &&
      pageBytes(messages) > BOUNDED_FRAME_CONTENT_BUDGET_BYTES &&
      messages.length > 1;
      attempt += 1
    ) {
      window = Math.max(1, Math.floor(messages.length / 2))
      page = await readTail(filePath, window, beforeOffset, signal)
      messages = stampChildMessages(page.messages, agentId)
    }
    if (pageBytes(messages) > BOUNDED_FRAME_CONTENT_BUDGET_BYTES) {
      messages = [oversizedChild(agentId)]
    }
    return { messages, hasMore: page.hasMore, beforeOffset: page.beforeOffset }
  } catch (error) {
    if (aborted(error, signal)) {
      throw error
    }
    return null
  }
}

function pageBytes(messages: readonly NativeChatMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages))
}

function oversizedChild(agentId: string): NativeChatMessage {
  return {
    id: `${agentId}:oversized`,
    role: 'system',
    blocks: [{ type: 'text', text: 'This part of the subagent transcript is too large to show.' }],
    timestamp: null,
    source: 'transcript',
    agentId
  }
}

async function codexChildPath(
  filePath: string,
  agentId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const threadId = await codexThreadId(filePath, agentId, signal)
  if (!threadId) {
    return null
  }
  const dayDir = dirname(filePath)
  const inDay = matchRollout(await readDir(dayDir, signal), dayDir, threadId)
  if (inDay) {
    return inDay
  }
  const monthDir = dirname(dayDir)
  const monthEntries = await readDir(monthDir, signal)
  if (!monthEntries) {
    return null
  }
  for (const entry of monthEntries) {
    if (!entry.isDirectory()) {
      continue
    }
    const sibling = join(monthDir, entry.name)
    if (sibling === dayDir) {
      continue
    }
    const found = matchRollout(await readDir(sibling, signal), sibling, threadId)
    if (found) {
      return found
    }
  }
  return null
}

async function codexThreadId(
  filePath: string,
  agentId: string,
  signal?: AbortSignal
): Promise<string | null> {
  // The structured roster names the child by its rollout id, not by agent_path.
  if (CODEX_THREAD_ID.test(agentId)) {
    return agentId
  }
  let threadId: string | null = null
  const stream = openTranscriptReadStream(filePath, { encoding: 'utf-8' }, 'exact', signal)
  try {
    for await (const record of splitTranscriptStreamLines(stream)) {
      const next = codexLinkThread(record.line, agentId)
      if (next) {
        threadId = next
      }
    }
  } catch (error) {
    if (aborted(error, signal)) {
      throw error
    }
  } finally {
    stream.destroy()
  }
  return threadId
}

function codexLinkThread(line: string, agentId: string): string | null {
  if (!line.includes('SubAgentActivity')) {
    return null
  }
  const item = asRecord(asRecord(parseJsonObject(line)?.payload)?.item)
  if (item?.type !== 'SubAgentActivity' || extractString(item.agent_path) !== agentId) {
    return null
  }
  const threadId = extractString(item.agent_thread_id)
  return threadId && CODEX_THREAD_ID.test(threadId) ? threadId : null
}

function matchRollout(entries: Dirent[] | null, dir: string, threadId: string): string | null {
  if (!entries) {
    return null
  }
  const suffix = `-${threadId}.jsonl`
  const match = entries.find(
    (entry) => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)
  )
  return match ? join(dir, match.name) : null
}

function stampChildMessages(
  messages: readonly NativeChatMessage[],
  agentId: string
): NativeChatMessage[] {
  const stamped: NativeChatMessage[] = []
  for (const message of messages) {
    stamped.push({ ...message, id: `${agentId}:${message.id}`, agentId })
  }
  return stamped
}

async function readDir(path: string, signal?: AbortSignal): Promise<Dirent[] | null> {
  try {
    return await wslGatedReaddir(path, 'exact', signal)
  } catch (error) {
    if (aborted(error, signal)) {
      throw error
    }
    return null
  }
}

function aborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}
