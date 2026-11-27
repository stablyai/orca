import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../../scan-lifecycle/ai-vault-scan-cancellation'
import {
  wslGatedReaddir,
  wslGatedReadFile
} from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { isMissingTranscriptPathError } from '../../discovery/session-path-absence'
import { basename, dirname, join } from 'node:path'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { FileWithMtime, SessionAccumulator } from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import {
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from '../../parsing/session-scanner-accumulator'
import { addSessionContent, addPreviewMessage } from '../../parsing/session-scanner-messages'
import { asRecord } from '../../parsing/session-record-fields'
import { extractString } from '../../../../shared/text/trimmed-string'
import { timeObjectValue, timestampMs } from '../../parsing/session-record-time'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'
import { tokenTotal } from '../../parsing/session-scanner-token-values'

/** Scope discovery reads cwd without opening message files. */
export function openCodeSessionCwd(record: Record<string, unknown>): string | null {
  return extractString(record.directory)
}

export async function parseOpenCodeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const parsed: unknown = JSON.parse(
    await waitForAiVaultScan(wslGatedReadFile(file.path, 'utf-8', 'scan', signal), signal)
  )
  const record = asRecord(parsed)
  if (!record) {
    return null
  }
  const sessionId = extractString(record.id) ?? sessionIdFromFileName(file.path)
  const accumulator = createAccumulator({ agent: 'opencode', file, sessionId, messages })
  accumulator.title = normalizeTitleText(extractString(record.title) ?? '')
  accumulator.cwd = openCodeSessionCwd(record)
  updateTimeline(accumulator, timeObjectValue(record.time, 'created'))
  updateTimeline(accumulator, timeObjectValue(record.time, 'updated'))
  await consumeOpenCodeMessages(accumulator, findOpenCodeStorageRoot(file.path), sessionId, signal)
  return finalizeSession(accumulator, platform)
}

async function readOpenCodeJsonDirectory(
  directory: string,
  signal?: AbortSignal
): Promise<{ name: string; record: Record<string, unknown> }[]> {
  let entries
  try {
    entries = await waitForAiVaultScan(wslGatedReaddir(directory, 'scan', signal), signal)
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    if (!isMissingTranscriptPathError(error)) {
      throw error
    }
    return []
  }
  const records: { name: string; record: Record<string, unknown> }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    const record = await readOpenCodeJsonRecord(join(directory, entry.name), signal)
    if (record) {
      records.push({ name: entry.name, record })
    }
  }
  return records
}

/** Malformed JSON stays skippable; an I/O refusal must not become a complete cached transcript. */
export async function readOpenCodeJsonRecord(
  path: string,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  const content = await waitForAiVaultScan(wslGatedReadFile(path, 'utf-8', 'scan', signal), signal)
  try {
    const parsed: unknown = JSON.parse(content)
    return asRecord(parsed)
  } catch {
    return null
  }
}

// Rebuild arbitrary directory order by creation time; undated files sort last so they cannot displace the first prompt.
async function readOpenCodeMessagesInOrder(
  messageDir: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  const messages = (await readOpenCodeJsonDirectory(messageDir, signal)).map(({ name, record }) => {
    const createdMs = timestampMs(timeObjectValue(record.time, 'created'))
    return {
      name,
      createdMs: Number.isFinite(createdMs) ? createdMs : Number.POSITIVE_INFINITY,
      record
    }
  })
  return messages
    .sort((a, b) => a.createdMs - b.createdMs || a.name.localeCompare(b.name))
    .map((entry) => entry.record)
}

async function readOpenCodeMessageParts(
  storageRoot: string,
  messageId: unknown,
  signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  // Message IDs are storage keys, never paths outside their part directory.
  if (
    typeof messageId !== 'string' ||
    !messageId ||
    messageId === '.' ||
    messageId === '..' ||
    /[/\\\0]/.test(messageId)
  ) {
    return []
  }
  const entries = await readOpenCodeJsonDirectory(join(storageRoot, 'part', messageId), signal)
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return entries.flatMap(({ record }) => {
    if (record.type !== 'tool') {
      return [record]
    }
    const state = asRecord(record.state)
    return [
      { type: 'tool_use', name: record.tool, input: state?.input },
      { type: 'tool_result', content: state?.error ?? state?.output }
    ]
  })
}

export async function consumeOpenCodeMessages(
  accumulator: SessionAccumulator,
  storageRoot: string | null,
  sessionId: string,
  signal?: AbortSignal
): Promise<void> {
  if (!storageRoot) {
    return
  }
  for (const message of await readOpenCodeMessagesInOrder(
    join(storageRoot, 'message', sessionId),
    signal
  )) {
    await waitForAiVaultScan(accumulator.messages.drain?.() ?? Promise.resolve(), signal)
    const role = extractString(message.role)
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
      updateTimeline(accumulator, timeObjectValue(message.time, 'created'))
      const summary = asRecord(message.summary)
      if (role === 'user') {
        accumulator.title ??= extractString(summary?.title) ?? extractString(summary?.body)
      }
      const timestamp = timeObjectValue(message.time, 'created')
      const content =
        message.content ?? (await readOpenCodeMessageParts(storageRoot, message.id, signal))
      const hasPreview = addSessionContent(accumulator, role, content, timestamp)
      if (!hasPreview) {
        addPreviewMessage(accumulator, {
          role,
          text: extractString(summary?.body) ?? extractString(summary?.title),
          timestamp
        })
      }
      accumulator.model =
        extractString(asRecord(message.model)?.modelID) ||
        extractString(message.modelID) ||
        accumulator.model
      accumulator.totalTokens += tokenTotal(message.tokens)
    }
  }
}

function findOpenCodeStorageRoot(filePath: string): string | null {
  const sessionDir = dirname(filePath)
  const sessionRoot = dirname(sessionDir)
  if (basename(sessionRoot) !== 'session') {
    return null
  }
  return dirname(sessionRoot)
}
