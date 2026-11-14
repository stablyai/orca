import { readFile } from 'node:fs/promises'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { dshSessionIdFromFilePath, dshSessionLines } from '../../../../shared/dsh-session-log'
import { orcaDispatchTaskBodyOffset } from '../../../../shared/orca-dispatch-status-prompt'
import { admitWslTranscriptPath } from '../../../native-chat/transcript-filesystem/wsl-transcript-running-admission'
import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../../scan-lifecycle/ai-vault-scan-cancellation'
import {
  createAccumulator,
  finalizeSession,
  timestampIso,
  updateTimeline
} from '../../parsing/session-scanner-accumulator'
import { addSessionContent } from '../../parsing/session-scanner-messages'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'
import { numberValue } from '../../parsing/session-scanner-token-values'
import type { FileWithMtime, SessionAccumulator } from '../../session-scanner-types'
import { arrayValue, asRecord } from '../../parsing/session-record-fields'
import { parseJsonObject } from '../../parsing/session-json-object'
import { extractString } from '../../../../shared/trimmed-string'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'

/** Checks an aborting scan between frames' worth of rows without awaiting per line. */
const CANCELLATION_CHECK_INTERVAL = 256

type DshSessionHeader = {
  sessionId: string | null
  cwd: string | null
  createdAtMs: number | null
  isSubagent: boolean
}

function readDshSessionHeader(line: string): DshSessionHeader | null {
  const header = parseJsonObject(line)
  // Format generations keep the header and row envelope; older payloads parse best-effort.
  if (!header || extractString(header.type) !== 'session') {
    return null
  }
  return {
    sessionId: extractString(header.id),
    cwd: extractString(header.cwd),
    createdAtMs: numberValue(header.createdAt) || null,
    // A bare `parentSession` also appears on ordinary forks; only these two mark a child.
    isSubagent:
      numberValue(header.delegationDepth) > 0 || extractString(header.origin) === 'subagent'
  }
}

function textFromBlocks(content: unknown): string | null {
  const parts: string[] = []
  for (const block of arrayValue(content)) {
    const record = asRecord(block)
    if (extractString(record?.type) !== 'text') {
      continue
    }
    const text = extractString(record?.text)
    if (text) {
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/** Orca dispatches carry a coordinator preamble; the row should read as the task itself. */
function promptTextFromUserMessage(text: string): string {
  const bodyOffset = orcaDispatchTaskBodyOffset(text)
  if (bodyOffset === undefined) {
    return text
  }
  const body = text.slice(bodyOffset).trim()
  return body || text
}

function foldDshRow(accumulator: SessionAccumulator, row: Record<string, unknown>): void {
  const rowType = extractString(row.type)
  const data = asRecord(row.data)
  updateTimeline(accumulator, row.time)
  switch (rowType) {
    case 'user/message': {
      // Agent instructions, reminders and time context are not the user's ask.
      if (extractString(asRecord(data?.source)?.kind) !== 'user') {
        return
      }
      const rawText = textFromBlocks(data?.content)
      if (!rawText) {
        return
      }
      const text = promptTextFromUserMessage(rawText)
      accumulator.messageCount += 1
      accumulator.lastUserPrompt = text
      const titleCandidate = normalizeTitleText(text)
      if (titleCandidate) {
        accumulator.fallbackTitle ??= titleCandidate
      }
      addSessionContent(accumulator, 'user', text, row.time)
      return
    }
    case 'assistant/message': {
      const usage = asRecord(data?.usage)
      // Cached input repeats every step; sum only the tokens the model had to read and write.
      accumulator.totalTokens += numberValue(usage?.inputTokens) + numberValue(usage?.outputTokens)
      const text = textFromBlocks(asRecord(data?.message)?.content)
      if (!text) {
        return
      }
      accumulator.messageCount += 1
      addSessionContent(accumulator, 'assistant', text, row.time)
      return
    }
    case 'session/title': {
      const title = extractString(data?.title)
      const normalized = title ? normalizeTitleText(title) : null
      if (!normalized) {
        return
      }
      // The last title wins: a provider title or a user rename supersedes the first-prompt stand-in.
      if (extractString(asRecord(data?.source)?.kind) === 'fallback') {
        accumulator.fallbackTitle = normalized
      } else {
        accumulator.title = normalized
      }
      return
    }
    case 'model/selection':
    case 'request/context': {
      const model = extractString(data?.model)
      if (model) {
        accumulator.model = model
      }
      break
    }
    case null:
      break
  }
}

export async function parseDshSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  // Gated readers decode text only; this log is a Zstandard container, so admit the path first.
  if (isWslUncPath(file.path)) {
    await waitForAiVaultScan(admitWslTranscriptPath(file.path), signal)
  }
  const raw = await waitForAiVaultScan(readFile(file.path), signal)
  const lines = dshSessionLines(raw)
  const headerLine = lines.next()
  const header = headerLine.done ? null : readDshSessionHeader(headerLine.value)
  if (!header) {
    return null
  }
  // Subagent logs are separate files; History lists the conversation a user opened.
  if (header.isSubagent) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'dsh',
    file,
    sessionId: header.sessionId ?? dshSessionIdFromFilePath(file.path),
    messages
  })
  accumulator.cwd = header.cwd
  accumulator.createdAt = timestampIso(header.createdAtMs)
  let rowIndex = 0
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }
    rowIndex += 1
    if (rowIndex % CANCELLATION_CHECK_INTERVAL === 0) {
      throwIfAiVaultScanCancelled(signal)
    }
    const row = parseJsonObject(line)
    if (row) {
      foldDshRow(accumulator, row)
    }
    if (messages?.active) {
      await waitForAiVaultScan(messages.drain?.() ?? Promise.resolve(), signal)
    }
  }
  return finalizeSession(accumulator, platform)
}
