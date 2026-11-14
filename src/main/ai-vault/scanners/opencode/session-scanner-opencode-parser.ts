import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../../scan-lifecycle/ai-vault-scan-cancellation'
import {
  wslGatedReaddir,
  wslGatedReadFile
} from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-error'
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
import { extractString } from '../../../../shared/trimmed-string'
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

// Rebuild arbitrary directory order by creation time; undated files sort last so they cannot displace the first prompt.
async function readOpenCodeMessagesInOrder(
  messageDir: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  let entries
  try {
    entries = await waitForAiVaultScan(wslGatedReaddir(messageDir, 'scan', signal), signal)
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    // Propagate WSL refusal so an unreachable message directory is not cached as an empty transcript.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return []
  }
  const messages: { name: string; createdMs: number; message: Record<string, unknown> }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    let message: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(
        await waitForAiVaultScan(
          wslGatedReadFile(join(messageDir, entry.name), 'utf-8', 'scan', signal),
          signal
        )
      )
      message = asRecord(parsed)
    } catch (error) {
      throwIfAiVaultScanCancelled(signal)
      // Skip malformed live writes, but propagate WSL refusal so incomplete transcripts remain retryable.
      if (error instanceof WslTranscriptFsError) {
        throw error
      }
      continue
    }
    if (!message) {
      continue
    }
    const createdMs = timestampMs(timeObjectValue(message.time, 'created'))
    messages.push({
      name: entry.name,
      createdMs: Number.isFinite(createdMs) ? createdMs : Number.POSITIVE_INFINITY,
      message
    })
  }
  return messages
    .sort((a, b) => a.createdMs - b.createdMs || a.name.localeCompare(b.name))
    .map((entry) => entry.message)
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
      const hasPreview = addSessionContent(accumulator, role, message.content, timestamp)
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
