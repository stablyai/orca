import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSubagentListResult,
  AiVaultSubagentRunStatus
} from '../../shared/ai-vault-types'
import {
  codexSubagentDayDirectory,
  readCodexSubagentActivity,
  resolveCodexSubagentTranscript
} from '../../shared/codex-subagent-transcript'
import {
  openTranscriptReadStream,
  wslGatedReaddir,
  wslGatedStat
} from '../native-chat/wsl-transcript-fs-access'
import { sessionIdFromFileName, sessionSortTime } from './session-scanner-accumulator'
import { parseCodexSessionFile } from './session-scanner-codex-parser'
import {
  asRecord,
  errorMessage,
  extractString,
  parseJsonObject,
  timestampMs
} from './session-scanner-values'

const RUNNING_RECENCY_MS = 5 * 60_000
const PARSE_CONCURRENCY = 8
const SUBAGENT_FS_PRIORITY = 'scan'

type Child = {
  id: string
  description?: string
  startedAt: number
  interrupted: boolean
}

/** Lists Codex child rollouts referenced by one parent rollout. */
export async function listCodexSubagentSessions(args: {
  parentFilePath: string
  platform?: NodeJS.Platform
  now?: number
}): Promise<AiVaultSubagentListResult> {
  const issues: AiVaultScanIssue[] = []
  const children = await readChildren(args.parentFilePath)
  const entriesByDirectory = new Map<string, string[]>()
  const parsed: (AiVaultSession | null)[] = []
  for (let index = 0; index < children.length; index += PARSE_CONCURRENCY) {
    parsed.push(
      ...(await Promise.all(
        children.slice(index, index + PARSE_CONCURRENCY).map((child) =>
          parseChild({
            child,
            parentFilePath: args.parentFilePath,
            parentSessionId: sessionIdFromFileName(args.parentFilePath),
            entriesByDirectory,
            platform: args.platform ?? process.platform,
            now: args.now ?? Date.now(),
            issues
          })
        )
      ))
    )
  }
  return {
    sessions: parsed
      .filter((session): session is AiVaultSession => session !== null)
      .sort((left, right) => sessionSortTime(right) - sessionSortTime(left)),
    issues
  }
}

async function readChildren(parentFilePath: string): Promise<Child[]> {
  const children = new Map<string, Child>()
  const spawnTimes: number[] = []
  try {
    const lines = createInterface({
      input: openTranscriptReadStream(parentFilePath, { encoding: 'utf-8' }, SUBAGENT_FS_PRIORITY),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      if (isSpawnCall(record)) {
        const startedAt = timestampMs(record.timestamp)
        if (Number.isFinite(startedAt)) {
          spawnTimes.push(startedAt)
        }
      }
      const activity = readCodexSubagentActivity(record)
      if (!activity) {
        continue
      }
      const child = children.get(activity.id) ?? {
        id: activity.id,
        startedAt: activity.startedAt,
        interrupted: false
      }
      child.description = activity.description ?? child.description
      child.interrupted = activity.kind === 'interrupted'
      children.set(activity.id, child)
    }
  } catch {
    return []
  }
  for (const child of await discoverLinkedChildren(parentFilePath, spawnTimes)) {
    children.set(child.id, children.get(child.id) ?? child)
  }
  return [...children.values()]
}

function isSpawnCall(record: Record<string, unknown>): boolean {
  const payload = asRecord(record.payload)
  return (
    record.type === 'response_item' &&
    payload?.type === 'function_call' &&
    extractString(payload.name)
      ?.replaceAll(/[^a-z]/gi, '')
      .toLowerCase()
      .endsWith('spawnagent') === true
  )
}

async function discoverLinkedChildren(
  parentFilePath: string,
  spawnTimes: number[]
): Promise<Child[]> {
  const parentSessionId = sessionIdFromFileName(parentFilePath)
  const directories = new Set([dirname(parentFilePath)])
  for (const startedAt of spawnTimes) {
    const directory = codexSubagentDayDirectory(parentFilePath, startedAt)
    if (directory) {
      directories.add(directory)
    }
  }
  const children: Child[] = []
  for (const directory of directories) {
    let entries: string[]
    try {
      entries = (await wslGatedReaddir(directory, SUBAGENT_FS_PRIORITY))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name)
        .slice(-4096)
    } catch {
      continue
    }
    for (const entry of entries) {
      const filePath = join(directory, entry)
      if (filePath === parentFilePath) {
        continue
      }
      const child = await readLinkedChild(filePath, parentSessionId)
      if (child) {
        children.push(child)
      }
    }
  }
  return children
}

async function readLinkedChild(filePath: string, parentSessionId: string): Promise<Child | null> {
  try {
    const lines = createInterface({
      input: openTranscriptReadStream(filePath, { encoding: 'utf-8' }, SUBAGENT_FS_PRIORITY),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      const record = parseJsonObject(line)
      const payload = record?.type === 'session_meta' ? asRecord(record.payload) : null
      if (!payload) {
        continue
      }
      const spawn = asRecord(asRecord(asRecord(payload.source)?.subagent)?.thread_spawn)
      const parentId = extractString(spawn?.parent_thread_id)
      const id = extractString(payload.id)
      if (parentId !== parentSessionId || !id) {
        return null
      }
      const startedAt = timestampMs(record?.timestamp)
      return {
        id,
        description: extractString(spawn?.agent_nickname) ?? extractString(spawn?.agent_path) ?? id,
        startedAt: Number.isFinite(startedAt) ? startedAt : 0,
        interrupted: false
      }
    }
  } catch {}
  return null
}

async function parseChild(args: {
  child: Child
  parentFilePath: string
  parentSessionId: string
  entriesByDirectory: Map<string, string[]>
  platform: NodeJS.Platform
  now: number
  issues: AiVaultScanIssue[]
}): Promise<AiVaultSession | null> {
  const filePath = resolveCodexSubagentTranscript(
    args.parentFilePath,
    args.child.id,
    args.child.startedAt,
    args.entriesByDirectory
  )
  if (!filePath) {
    return null
  }
  try {
    const fileStat = await wslGatedStat(filePath, SUBAGENT_FS_PRIORITY)
    const [session, conversation] = await Promise.all([
      parseCodexSessionFile(
        { path: filePath, mtimeMs: fileStat.mtimeMs, modifiedAt: fileStat.mtime.toISOString() },
        args.platform,
        null,
        undefined,
        true
      ),
      readChildConversation(filePath)
    ])
    if (!session) {
      return null
    }
    return {
      ...session,
      title: args.child.description ?? session.title,
      messageCount: conversation.messageCount,
      subagent: {
        parentSessionId: args.parentSessionId,
        agentType: null,
        turnStartedAts: conversation.turnStartedAts,
        status: subagentStatus({
          interrupted: args.child.interrupted,
          completed: conversation.completed,
          mtimeMs: fileStat.mtimeMs,
          now: args.now
        })
      }
    }
  } catch (error) {
    args.issues.push({ agent: 'codex', path: filePath, message: errorMessage(error) })
    return null
  }
}

async function readChildConversation(filePath: string): Promise<{
  completed: boolean
  messageCount: number
  turnStartedAts: number[]
}> {
  const lines = createInterface({
    input: openTranscriptReadStream(filePath, { encoding: 'utf-8' }, SUBAGENT_FS_PRIORITY),
    crlfDelay: Infinity
  })
  let complete = false
  let messageCount = 0
  const turnStartedAts: number[] = []
  for await (const line of lines) {
    const record = parseJsonObject(line)
    if (record?.type !== 'event_msg') {
      continue
    }
    const payload = asRecord(record.payload)
    if (payload?.type === 'task_started') {
      complete = false
      messageCount += 1
      const startedAt = timestampMs(record.timestamp)
      if (Number.isFinite(startedAt)) {
        turnStartedAts.push(startedAt)
      }
    } else if (payload?.type === 'task_complete') {
      complete = true
      if (extractString(payload.last_agent_message)?.trim()) {
        messageCount += 1
      }
    }
  }
  return { completed: complete, messageCount, turnStartedAts }
}

function subagentStatus(args: {
  interrupted: boolean
  completed: boolean
  mtimeMs: number
  now: number
}): AiVaultSubagentRunStatus | null {
  if (args.interrupted) {
    return 'stopped'
  }
  if (args.completed) {
    return 'completed'
  }
  return args.now - args.mtimeMs <= RUNNING_RECENCY_MS ? 'running' : null
}
