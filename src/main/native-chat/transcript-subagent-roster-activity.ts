import type { Dirent } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { nativeChatRosterActivityLine } from '../../shared/native-chat/input/native-chat-roster-activity-line'
import type { NativeChatSubagentActivity } from '../../shared/native-chat/input/native-chat-activity'
import {
  SUBAGENT_TRANSCRIPT_PREFIX,
  subagentTranscriptsDirFor
} from '../ai-vault/session-scanner-subagent-transcripts'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { splitTranscriptStreamLines } from './transcript-stream-lines'
import { openTranscriptReadStream, wslGatedReaddir } from './wsl-transcript-fs-access'

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLAUDE_CHILD_ID = /^[A-Za-z0-9_-]{1,128}$/
const TAIL_BYTES = 32 * 1024

/** Fill roster rows the parent left blank with one line from the child file. */
export async function fillSubagentRosterActivity(
  agent: string,
  parentPath: string | undefined,
  activities: readonly NativeChatSubagentActivity[]
): Promise<NativeChatSubagentActivity[]> {
  if (!parentPath || (agent !== 'claude' && agent !== 'codex')) {
    return activities.slice()
  }
  if (activities.every((entry) => entry.activity)) {
    return activities.slice()
  }
  const threads = agent === 'codex' ? await codexThreads(parentPath) : null
  const filled: NativeChatSubagentActivity[] = []
  for (const entry of activities) {
    if (entry.activity) {
      filled.push(entry)
      continue
    }
    const childPath =
      agent === 'claude'
        ? claudeChildPath(parentPath, entry.id)
        : await codexChildPath(parentPath, threads?.get(entry.id))
    const activity = childPath ? await peekActivity(childPath) : null
    filled.push(activity ? { ...entry, activity } : entry)
  }
  return filled
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

async function codexThreads(parentPath: string): Promise<Map<string, string>> {
  const threads = new Map<string, string>()
  const stream = openTranscriptReadStream(parentPath, { encoding: 'utf-8' }, 'exact')
  try {
    for await (const record of splitTranscriptStreamLines(stream)) {
      if (!record.line.includes('SubAgentActivity')) {
        continue
      }
      const item = asRecord(asRecord(parseJsonObject(record.line)?.payload)?.item)
      if (item?.type !== 'SubAgentActivity') {
        continue
      }
      const path = extractString(item.agent_path)
      const threadId = extractString(item.agent_thread_id)
      if (path && threadId && CODEX_THREAD_ID.test(threadId)) {
        threads.set(path, threadId)
      }
    }
  } catch {
    return threads
  } finally {
    stream.destroy()
  }
  return threads
}

async function codexChildPath(
  parentPath: string,
  threadId: string | undefined
): Promise<string | null> {
  if (!threadId) {
    return null
  }
  const dayDir = dirname(parentPath)
  const inDay = matchRollout(await readDir(dayDir), dayDir, threadId)
  if (inDay) {
    return inDay
  }
  const monthDir = dirname(dayDir)
  const monthEntries = await readDir(monthDir)
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
    const found = matchRollout(await readDir(sibling), sibling, threadId)
    if (found) {
      return found
    }
  }
  return null
}

function matchRollout(entries: Dirent[] | null, dir: string, threadId: string): string | null {
  const suffix = `-${threadId}.jsonl`
  const match = entries?.find(
    (entry) => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)
  )
  return match ? join(dir, match.name) : null
}

async function readDir(path: string): Promise<Dirent[] | null> {
  try {
    return await wslGatedReaddir(path, 'exact')
  } catch {
    return null
  }
}

async function peekActivity(filePath: string): Promise<string | null> {
  const handle = await open(filePath, 'r').catch(() => null)
  if (!handle) {
    return null
  }
  try {
    const info = await handle.stat()
    const length = Math.min(TAIL_BYTES, info.size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, info.size - length))
    return activityFromTail(buffer.toString('utf8'))
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

function activityFromTail(tail: string): string | null {
  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lineFromRecord(parseJsonObject(lines[index] ?? ''))
    if (line) {
      return line
    }
  }
  return null
}

function lineFromRecord(value: unknown): string | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const payload = asRecord(record.payload) ?? record
  if (payload.type === 'task_complete') {
    const last = extractString(payload.last_agent_message)
    if (last) {
      return nativeChatRosterActivityLine(last)
    }
  }
  const item = asRecord(payload.item)
  if (item?.type === 'AgentMessage') {
    return textFromContent(item.content)
  }
  const message = asRecord(record.message)
  if (message?.role === 'assistant') {
    return textFromContent(message.content)
  }
  return null
}

function textFromContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return nativeChatRosterActivityLine(content)
  }
  if (!Array.isArray(content)) {
    return null
  }
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = asRecord(content[index])
    if (block?.type === 'text') {
      const text = extractString(block.text)
      const line = text ? nativeChatRosterActivityLine(text) : null
      if (line) {
        return line
      }
    }
  }
  return null
}
