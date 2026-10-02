import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { AiVaultSession, AiVaultSubagentListResult } from '../../shared/ai-vault-types'
import {
  buildGrokChatHistoryPathCandidates,
  GROK_CHAT_HISTORY_FILE,
  GROK_SESSION_GROUP_SCAN_MAX_ENTRIES,
  isSafeGrokSessionId
} from '../../shared/grok-session-paths'
import {
  wslGatedLstat,
  wslGatedReadFile,
  wslGatedReaddir
} from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { readNativeChatTranscript } from '../native-chat/transcript-reader'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  sessionSortTime,
  timestampIso,
  updateTimeline
} from './session-scanner-accumulator'
import {
  asRecord,
  errorMessage,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

const MAX_CHILDREN = 4096
const MAX_METADATA_BYTES = 64 * 1024
const GROK_UPDATES_FILE = 'updates.jsonl'

/** Parent-owned metadata, not fork ancestry in summary.json, establishes ownership. */
export async function listGrokSubagentSessions(args: {
  parentFilePath: string
  platform?: NodeJS.Platform
}): Promise<AiVaultSubagentListResult> {
  const result: AiVaultSubagentListResult = { sessions: [], issues: [] }
  const parentFilePath = resolve(args.parentFilePath)
  if (
    ![GROK_CHAT_HISTORY_FILE, GROK_UPDATES_FILE, 'summary.json'].includes(basename(parentFilePath))
  ) {
    return result
  }
  const parentDir = dirname(parentFilePath)
  const parentId = basename(parentDir)
  const root = dirname(dirname(parentDir))
  if (!isSafeGrokSessionId(parentId) || basename(root) !== 'sessions') {
    return result
  }
  const childrenDir = join(parentDir, 'subagents')
  try {
    if (
      !(await safePath(root, parentFilePath, false)) ||
      !(await safePath(root, childrenDir, true))
    ) {
      return result
    }
    const entries = await wslGatedReaddir(childrenDir, 'scan')
    let groupNames: string[] | undefined
    const seen = new Set<string>()
    for (const entry of entries.slice(0, MAX_CHILDREN)) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeGrokSessionId(entry.name)) {
        continue
      }
      const metaPath = join(childrenDir, entry.name, 'meta.json')
      try {
        if (!(await safePath(root, metaPath, false))) {
          continue
        }
        const stat = await wslGatedLstat(metaPath, 'scan')
        if (stat.size > MAX_METADATA_BYTES) {
          continue
        }
        const meta = parseJsonObject(await wslGatedReadFile(metaPath, 'utf-8', 'scan'))
        const childId = extractString(meta?.child_session_id)
        if (
          !meta ||
          meta.parent_session_id !== parentId ||
          meta.subagent_id !== entry.name ||
          !childId ||
          !isSafeGrokSessionId(childId) ||
          childId === parentId ||
          seen.has(childId)
        ) {
          continue
        }
        let history: string | null = null
        const candidates = buildGrokChatHistoryPathCandidates({
          sessionsDir: root,
          sessionId: childId,
          cwd: extractString(meta.child_cwd)
        }).map((candidate) => join(dirname(candidate), GROK_UPDATES_FILE))
        for (const candidate of candidates) {
          if (await safePath(root, candidate, false)) {
            history = candidate
            break
          }
        }
        if (!history) {
          // Slug/hash cwd layouts need only bounded probes for this exact child ID.
          groupNames ??= (await wslGatedReaddir(root, 'scan'))
            .filter((group) => group.isDirectory() && !group.isSymbolicLink())
            .slice(0, GROK_SESSION_GROUP_SCAN_MAX_ENTRIES)
            .map((group) => group.name)
          for (const group of groupNames) {
            const candidate = join(root, group, childId, GROK_UPDATES_FILE)
            if (await safePath(root, candidate, false)) {
              history = candidate
              break
            }
          }
        }
        if (!history) {
          continue
        }
        const session = await readChild(
          history,
          meta,
          parentId,
          root,
          args.platform ?? process.platform
        )
        if (session) {
          seen.add(childId)
          result.sessions.push(session)
        }
      } catch (error) {
        result.issues.push({ agent: 'grok', path: metaPath, message: errorMessage(error) })
      }
    }
  } catch (error) {
    result.issues.push({ agent: 'grok', path: childrenDir, message: errorMessage(error) })
  }
  result.sessions.sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
  return result
}

async function safePath(root: string, candidate: string, directory: boolean): Promise<boolean> {
  const parts = relative(root, candidate).split(sep)
  if (!parts.length || parts.some((part) => !part || part === '..')) {
    return false
  }
  try {
    let current = root
    for (let index = -1; index < parts.length; index += 1) {
      if (index >= 0) {
        current = join(current, parts[index])
      }
      const stat = await wslGatedLstat(current, 'scan')
      if (stat.isSymbolicLink()) {
        return false
      }
      if (index < parts.length - 1 || directory) {
        if (!stat.isDirectory()) {
          return false
        }
      } else if (!stat.isFile()) {
        return false
      }
    }
    return true
  } catch (error) {
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return false
  }
}

async function readChild(
  history: string,
  meta: Record<string, unknown>,
  parentId: string,
  root: string,
  platform: NodeJS.Platform
): Promise<AiVaultSession | null> {
  const stat = await wslGatedLstat(history, 'scan')
  const accumulator = createAccumulator({
    agent: 'grok',
    sessionId: basename(dirname(history)),
    file: { path: history, mtimeMs: stat.mtimeMs, modifiedAt: stat.mtime.toISOString() }
  })
  accumulator.cwd = extractString(meta.child_cwd)
  accumulator.title = normalizeTitleText(extractString(meta.description) ?? '')
  accumulator.model = extractString(meta.effective_model_id)
  const summaryPath = join(dirname(history), 'summary.json')
  if (await safePath(root, summaryPath, false)) {
    const summaryStat = await wslGatedLstat(summaryPath, 'scan')
    if (summaryStat.size <= MAX_METADATA_BYTES) {
      const summary = parseJsonObject(await wslGatedReadFile(summaryPath, 'utf-8', 'scan'))
      if (asRecord(summary?.info)?.id === accumulator.sessionId) {
        accumulator.model ??= extractString(summary?.current_model_id)
      }
    }
  }
  updateTimeline(accumulator, meta.started_at)
  updateTimeline(accumulator, meta.completed_at)
  const turnStartedAts: number[] = []
  const transcript = await readNativeChatTranscript('grok', accumulator.sessionId, {
    filePath: history
  })
  if ('error' in transcript) {
    throw new Error(transcript.error)
  }
  for (const message of transcript.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }
    const text = message.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    if (!text.trim() && !message.blocks.some((block) => block.type === 'image-ref')) {
      continue
    }
    accumulator.messageCount += 1
    addPreviewMessage(accumulator, { role: message.role, text, timestamp: message.timestamp })
    updateTimeline(accumulator, message.timestamp)
    const timestamp = timestampIso(message.timestamp)
    if (message.role === 'user' && timestamp) {
      turnStartedAts.push(Date.parse(timestamp))
    }
  }
  const session = finalizeSession(accumulator, platform)
  if (!session) {
    return null
  }
  return {
    ...session,
    subagent: {
      parentSessionId: parentId,
      agentType: extractString(meta.subagent_type),
      turnStartedAts,
      status:
        meta.status === 'cancelled'
          ? 'stopped'
          : meta.status === 'running' || meta.status === 'completed' || meta.status === 'failed'
            ? meta.status
            : null
    }
  }
}
