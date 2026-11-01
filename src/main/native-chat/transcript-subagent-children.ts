import { type Dirent } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import {
  isSubagentTranscriptFileName,
  SUBAGENT_TRANSCRIPT_PREFIX,
  subagentTranscriptsDirFor
} from '../ai-vault/session-scanner-subagent-transcripts'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { decodeTranscriptStream, splitTranscriptStreamLines } from './transcript-stream-lines'
import { openTranscriptReadStream, wslGatedReaddir } from './wsl-transcript-fs-access'

type NativeChatLineDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
 * Decode child transcripts onto a live parent snapshot.
 * Callers skip historical pages so paging does not repeat these rows.
 */
export async function appendNativeChatChildTranscripts(
  filePath: string,
  decode: NativeChatLineDecoder,
  messages: readonly NativeChatMessage[],
  signal?: AbortSignal
): Promise<NativeChatMessage[]> {
  const children =
    decode === decodeClaudeTranscriptLine
      ? await claudeChildren(filePath, decode, signal)
      : decode === decodeCodexTranscriptLine
        ? await codexChildren(filePath, decode, signal)
        : []
  return children.length > 0 ? [...messages, ...children] : messages.slice()
}

async function claudeChildren(
  filePath: string,
  decode: NativeChatLineDecoder,
  signal?: AbortSignal
): Promise<NativeChatMessage[]> {
  const directory = subagentTranscriptsDirFor(filePath)
  const entries = await readDir(directory, signal)
  if (!entries) {
    return []
  }
  const files = entries
    .filter((entry) => isSubagentTranscriptFileName(entry.name, entry.isFile()))
    .sort((left, right) => left.name.localeCompare(right.name))
  const children: NativeChatMessage[] = []
  for (const entry of files) {
    const agentId = claudeChildAgentId(entry.name)
    if (!agentId) {
      continue
    }
    const decoded = await readChildFile(join(directory, entry.name), decode, signal)
    children.push(...stampChildMessages(decoded, agentId))
  }
  return children
}

async function codexChildren(
  filePath: string,
  decode: NativeChatLineDecoder,
  signal?: AbortSignal
): Promise<NativeChatMessage[]> {
  const links = await codexChildLinks(filePath, signal)
  if (links.size === 0) {
    return []
  }
  const dayDir = dirname(filePath)
  const index: RolloutIndex = {
    dayDir,
    dayEntries: await readDir(dayDir, signal),
    monthDir: dirname(dayDir),
    monthEntries: undefined
  }
  const children: NativeChatMessage[] = []
  for (const [threadId, agentId] of links) {
    const childPath = await findCodexRollout(index, threadId, signal)
    if (!childPath) {
      continue
    }
    const decoded = await readChildFile(childPath, decode, signal)
    children.push(...stampChildMessages(decoded, agentId))
  }
  return children
}

type RolloutIndex = {
  dayDir: string
  dayEntries: Dirent[] | null
  monthDir: string
  monthEntries: Dirent[] | null | undefined
}

async function findCodexRollout(
  index: RolloutIndex,
  threadId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const inDay = matchRollout(index.dayEntries, index.dayDir, threadId)
  if (inDay) {
    return inDay
  }
  if (index.monthEntries === undefined) {
    index.monthEntries = await readDir(index.monthDir, signal)
  }
  if (!index.monthEntries) {
    return null
  }
  for (const entry of index.monthEntries) {
    if (!entry.isDirectory()) {
      continue
    }
    const sibling = join(index.monthDir, entry.name)
    if (sibling === index.dayDir) {
      continue
    }
    const found = matchRollout(await readDir(sibling, signal), sibling, threadId)
    if (found) {
      return found
    }
  }
  return null
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

async function codexChildLinks(
  filePath: string,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const links = new Map<string, string>()
  const stream = openTranscriptReadStream(filePath, { encoding: 'utf-8' }, 'exact', signal)
  try {
    for await (const record of splitTranscriptStreamLines(stream)) {
      rememberCodexLink(links, record.line)
    }
  } catch (error) {
    if (aborted(error, signal)) {
      throw error
    }
  } finally {
    stream.destroy()
  }
  return links
}

function rememberCodexLink(links: Map<string, string>, line: string): void {
  if (!line.includes('SubAgentActivity')) {
    return
  }
  const record = parseJsonObject(line)
  const item = asRecord(asRecord(record?.payload)?.item)
  if (item?.type !== 'SubAgentActivity') {
    return
  }
  const threadId = extractString(item.agent_thread_id)
  if (!threadId || !CODEX_THREAD_ID.test(threadId)) {
    return
  }
  links.set(threadId, extractString(item.agent_path) ?? threadId)
}

function claudeChildAgentId(name: string): string | null {
  const extension = extname(name)
  const agentId = name.slice(SUBAGENT_TRANSCRIPT_PREFIX.length, name.length - extension.length)
  return agentId.length > 0 ? agentId : null
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

async function readChildFile(
  filePath: string,
  decode: NativeChatLineDecoder,
  signal?: AbortSignal
): Promise<NativeChatMessage[]> {
  const stream = openTranscriptReadStream(filePath, { encoding: 'utf-8' }, 'exact', signal)
  try {
    const decoded = await decodeTranscriptStream(stream, filePath, 0, decode, true)
    return decoded.messages
  } catch (error) {
    if (aborted(error, signal)) {
      throw error
    }
    return []
  } finally {
    stream.destroy()
  }
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
