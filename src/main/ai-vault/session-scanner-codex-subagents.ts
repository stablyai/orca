import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSubagentListResult,
  AiVaultSubagentRunStatus
} from '../../shared/ai-vault-types'
import {
  readCodexSubagentActivity,
  resolveCodexSubagentTranscript
} from '../../shared/codex-subagent-transcript'
import { sessionIdFromFileName, sessionSortTime } from './session-scanner-accumulator'
import { parseCodexSessionFile } from './session-scanner-codex-parser'
import { asRecord, errorMessage, parseJsonObject } from './session-scanner-values'

const RUNNING_RECENCY_MS = 5 * 60_000
const PARSE_CONCURRENCY = 8

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
  try {
    const lines = createInterface({
      input: createReadStream(parentFilePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
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
  return [...children.values()]
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
    const fileStat = await stat(filePath)
    const [session, completed] = await Promise.all([
      parseCodexSessionFile(
        { path: filePath, mtimeMs: fileStat.mtimeMs, modifiedAt: fileStat.mtime.toISOString() },
        args.platform,
        null,
        undefined,
        true
      ),
      childIsComplete(filePath)
    ])
    if (!session) {
      return null
    }
    return {
      ...session,
      title: args.child.description ?? session.title,
      subagent: {
        parentSessionId: args.parentSessionId,
        agentType: null,
        status: subagentStatus({
          interrupted: args.child.interrupted,
          completed,
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

async function childIsComplete(filePath: string): Promise<boolean> {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  let complete = false
  for await (const line of lines) {
    const record = parseJsonObject(line)
    if (record?.type !== 'event_msg') {
      continue
    }
    const payload = asRecord(record.payload)
    if (payload?.type === 'task_started') {
      complete = false
    } else if (payload?.type === 'task_complete') {
      complete = true
    }
  }
  return complete
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
