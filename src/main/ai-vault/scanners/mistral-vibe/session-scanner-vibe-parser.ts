import { createInterface } from 'node:readline'
import { basename, dirname, join } from 'node:path'
import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../../scan-lifecycle/ai-vault-scan-cancellation'
import {
  openTranscriptReadStream,
  wslGatedReadFile
} from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { FileWithMtime } from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import {
  createAccumulator,
  finalizeSession,
  updateTimeline
} from '../../parsing/session-scanner-accumulator'
import { addSessionContent, addSessionText } from '../../parsing/session-scanner-messages'
import { arrayValue, asRecord } from '../../parsing/session-record-fields'
import { isMissingTranscriptPathError } from '../../discovery/session-path-absence'
import { extractString } from '../../../../shared/text/trimmed-string'
import { parseJsonObject } from '../../parsing/session-json-object'
import { AiVaultScanIssueError } from '../../parsing/session-scan-issues'
import { aiVaultScanIssueText } from '../../../../shared/ai-vault/scanning/ai-vault-scan-issue-copy'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'
import { numberValue } from '../../parsing/session-scanner-token-values'

const VIBE_PREVIEW_SCAN_LIMIT = 4096

/** session_<ts>_<id> directory names carry the short id; meta.json carries the full session_id. */
function vibeSessionIdFromDirectory(filePath: string): string | null {
  const dir = basename(dirname(filePath))
  const match = /^session_\d{8}_\d{6}_(.+)$/u.exec(dir)
  return match?.[1] ?? null
}

/** Vibe stores assistant tool calls as function entries; decode them as tool_use blocks. */
function vibeToolCallsAsToolUse(toolCalls: unknown): unknown[] {
  return arrayValue(toolCalls).flatMap((call) => {
    const fn = asRecord(asRecord(call)?.function)
    const name = extractString(fn?.name)
    if (!name) {
      return []
    }
    const rawArguments = fn?.arguments
    let input: unknown = {}
    if (typeof rawArguments === 'string') {
      try {
        input = JSON.parse(rawArguments)
      } catch {
        // A malformed arguments string keeps the call, with the raw text as its input.
        input = { arguments: rawArguments }
      }
    } else if (rawArguments != null) {
      input = rawArguments
    }
    return [{ type: 'tool_use', id: extractString(asRecord(call)?.id) ?? name, name, input }]
  })
}

/** Parses a Vibe session's messages.jsonl, enriched by its meta.json sidecar. */
export async function parseVibeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const metaContent = await waitForAiVaultScan(
    wslGatedReadFile(join(dirname(file.path), 'meta.json'), 'utf-8', 'scan', signal).catch(
      (error: unknown) => {
        // Only a missing sidecar falls back to the directory-derived id; other read failures
        // propagate so the scan records an issue instead of caching a metadata-free session.
        if (!isMissingTranscriptPathError(error)) {
          throw error
        }
        return null
      }
    ),
    signal
  )
  // A sidecar that exists but does not parse would silently degrade to the short directory id,
  // which vibe --resume may not resolve; record an issue instead of caching that session.
  const meta = metaContent === null ? null : parseJsonObject(metaContent)
  if (metaContent !== null && meta === null) {
    throw new AiVaultScanIssueError(aiVaultScanIssueText('sessionMetadataUnreadable'))
  }
  const sessionId = extractString(meta?.session_id) ?? vibeSessionIdFromDirectory(file.path)
  if (!sessionId) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'mistral-vibe',
    file,
    sessionId,
    messages
  })
  accumulator.title = normalizeTitleText(extractString(meta?.title) ?? '')
  accumulator.cwd = extractString(asRecord(meta?.environment)?.working_directory)
  accumulator.branch = extractString(meta?.git_branch)
  accumulator.model = extractString(asRecord(meta?.config)?.active_model)
  accumulator.totalTokens = numberValue(asRecord(meta?.stats)?.session_total_llm_tokens)
  updateTimeline(accumulator, meta?.start_time)
  updateTimeline(accumulator, meta?.end_time)

  const input = openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan', signal)
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      await waitForAiVaultScan(messages?.drain?.() ?? Promise.resolve(), signal)
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      accumulator.messageCount += 1
      const role = extractString(record.role)
      if (role === 'user') {
        const text = typeof record.content === 'string' ? record.content : null
        if (text) {
          accumulator.title ??= normalizeTitleText(text)
          accumulator.lastUserPrompt = text
        }
        addSessionText(accumulator, {
          role: 'user',
          text,
          previewScanLimit: VIBE_PREVIEW_SCAN_LIMIT
        })
      } else if (role === 'assistant') {
        const parts: unknown[] = []
        if (record.content != null) {
          parts.push(record.content)
        }
        parts.push(...vibeToolCallsAsToolUse(record.tool_calls))
        addSessionContent(
          accumulator,
          'assistant',
          parts.length === 1 ? parts[0] : parts,
          undefined,
          {
            previewScanLimit: VIBE_PREVIEW_SCAN_LIMIT
          }
        )
      } else if (role === 'tool') {
        addSessionContent(accumulator, 'tool', record.content, undefined, {
          previewScanLimit: VIBE_PREVIEW_SCAN_LIMIT
        })
      }
    }
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    throw error
  } finally {
    lines.close()
    input.destroy()
  }
  return finalizeSession(accumulator, platform)
}
