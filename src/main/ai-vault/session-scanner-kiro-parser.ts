import { openTranscriptReadStream, wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { basename, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  addPreviewContent,
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { kiroMessagesPathForManifest } from './session-scanner-kiro-paths'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  arrayValue,
  asRecord,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

// Parses a kiro-cli V3 `session.json` plus its sibling `messages.jsonl` into an AI Vault session.
// The manifest carries the id, title, workspace, model and timestamps; the transcript supplies
// the user and assistant turns for preview and search.
export async function parseKiroSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  let manifestText: string
  try {
    manifestText = await wslGatedReadFile(file.path, 'utf-8', 'scan')
  } catch (error) {
    // Why: only a manifest that is gone is "no session". A gate refusal or a transient read error
    // (a Windows sharing violation while Kiro rewrites the file) must surface as a scan issue, or
    // the parse cache keeps the missing row under the file's unchanged mtime and never retries.
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
  let manifest: Record<string, unknown> | null
  try {
    manifest = asRecord(JSON.parse(manifestText) as unknown)
  } catch {
    return null
  }
  if (!manifest) {
    return null
  }

  // Why the id field first: it is exactly what `kiro-cli chat --resume-id` takes; the directory
  // name carries the same `sess_<uuid>` and only stands in when the field is missing.
  const sessionId = extractString(manifest.id) ?? basename(dirname(file.path))
  const accumulator = createAccumulator({ agent: 'kiro', file, sessionId, messages })
  accumulator.cwd = arrayValue(manifest.workspacePaths).map(extractString).find(Boolean) ?? null
  accumulator.title = normalizeTitleText(extractString(manifest.title) ?? '')
  accumulator.model = extractString(manifest.modelId)
  updateTimeline(accumulator, extractString(manifest.createdAt))
  updateTimeline(accumulator, extractString(manifest.lastModifiedAt))

  await consumeKiroTranscript(accumulator, kiroMessagesPathForManifest(file.path))

  return finalizeSession(accumulator, platform)
}

async function consumeKiroTranscript(
  accumulator: SessionAccumulator,
  messagesPath: string
): Promise<void> {
  const input = openTranscriptReadStream(messagesPath, { encoding: 'utf-8' }, 'scan')
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const record = parseJsonObject(line)
      const payload = asRecord(record?.payload)
      if (!record || !payload) {
        continue
      }
      updateTimeline(accumulator, record.timestamp)
      if (payload.type === 'user') {
        accumulator.messageCount++
        accumulator.fallbackTitle ??= normalizeTitleText(extractString(payload.content) ?? '')
        addPreviewContent(accumulator, 'user', payload.content, record.timestamp)
        continue
      }
      // Why only `Say`: Kiro also logs `Reasoning` (thinking) and `Summary` (compaction) as
      // assistant entries, and neither is a reply the user saw.
      if (payload.type === 'assistant' && payload.operationType === 'Say') {
        accumulator.messageCount++
        addPreviewMessage(accumulator, {
          role: 'assistant',
          text: extractString(payload.content),
          timestamp: record.timestamp
        })
      }
    }
  } catch (error) {
    // No transcript yet (a session opened but never prompted) still belongs in the panel; any other
    // failure means the bytes exist but were unreadable, so a partial session must not be cached.
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  } finally {
    // readline.close() leaves the underlying stream open; destroy it so a mid-read failure cannot
    // leak the gated transcript handle.
    lines.close()
    input.destroy()
  }
}
