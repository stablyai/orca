import { openTranscriptReadStream, wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { createAccumulator, finalizeSession, updateTimeline } from './session-scanner-accumulator'
import { addSessionContent, addSessionText } from './session-scanner-messages'
import {
  kimiPrimaryAgentWirePath,
  kimiSessionIdFromStatePath,
  kimiSessionIndexPathFromStatePath,
  readKimiWorkDirBySessionId
} from './session-scanner-kimi-paths'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  asRecord,
  extractContentText,
  extractString,
  normalizeTitleText,
  numberValue,
  parseJsonObject
} from './session-scanner-values'

// State supplies metadata, session_index supplies cwd, and the wire transcript supplies messages and usage.
export async function parseKimiSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  let stateRecord: Record<string, unknown> | null
  try {
    stateRecord = asRecord(
      JSON.parse(await wslGatedReadFile(file.path, 'utf-8', 'scan')) as unknown
    )
  } catch (error) {
    // Propagate WSL refusal so an unreachable state file is not cached as no session.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return null
  }
  if (!stateRecord) {
    return null
  }

  const sessionId = kimiSessionIdFromStatePath(file.path)
  const accumulator = createAccumulator({ agent: 'kimi', file, sessionId, messages })

  // Kimi resume requires the indexed work directory; session IDs alone are not sufficient.
  const workDirBySessionId = await readKimiWorkDirBySessionId(
    kimiSessionIndexPathFromStatePath(file.path)
  )
  accumulator.cwd = workDirBySessionId.get(sessionId) ?? null

  accumulator.title = normalizeTitleText(extractString(stateRecord.title) ?? '')
  accumulator.fallbackTitle = normalizeTitleText(extractString(stateRecord.lastPrompt) ?? '')
  updateTimeline(accumulator, extractString(stateRecord.createdAt))
  updateTimeline(accumulator, extractString(stateRecord.updatedAt))

  await consumeKimiWireTranscript(accumulator, kimiPrimaryAgentWirePath(file.path, stateRecord))

  return finalizeSession(accumulator, platform)
}

async function consumeKimiWireTranscript(
  accumulator: SessionAccumulator,
  wirePath: string
): Promise<void> {
  let pendingAssistantText: string[] = []
  const flushAssistant = (): void => {
    const text = pendingAssistantText.join('')
    pendingAssistantText = []
    if (text) {
      accumulator.messageCount++
      addSessionText(accumulator, { role: 'assistant', text })
    }
  }

  const input = openTranscriptReadStream(wirePath, { encoding: 'utf-8' }, 'scan')
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      switch (record.type) {
        case 'config.update':
          accumulator.model = extractString(record.modelAlias) ?? accumulator.model
          break
        case 'usage.record':
          accumulator.model = extractString(record.model) ?? accumulator.model
          accumulator.totalTokens += kimiUsageTotal(record.usage, record.usageScope)
          break
        case 'context.append_message':
          consumeKimiUserMessage(accumulator, record.message)
          break
        case 'context.append_loop_event':
          consumeKimiLoopEvent(record.event, pendingAssistantText, flushAssistant)
          break
        default:
          break
      }
    }
  } catch (error) {
    // Metadata-only sessions may list, but WSL refusal must propagate so missing wire content remains retryable.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
  } finally {
    // readline.close() leaves its input open; destroy the gated stream after read failures too.
    lines.close()
    input.destroy()
  }
  flushAssistant()
}

function consumeKimiUserMessage(accumulator: SessionAccumulator, value: unknown): void {
  const message = asRecord(value)
  // Kimi also labels injected reminders as user-role messages; origin.kind distinguishes real input.
  if (!message || message.role !== 'user' || asRecord(message.origin)?.kind !== 'user') {
    return
  }
  accumulator.messageCount++
  accumulator.title ??= extractContentText(message.content)
  addSessionContent(accumulator, 'user', message.content)
}

function consumeKimiLoopEvent(
  value: unknown,
  pendingAssistantText: string[],
  flushAssistant: () => void
): void {
  const event = asRecord(value)
  if (!event) {
    return
  }
  if (event.type === 'content.part') {
    const part = asRecord(event.part)
    // Normalize after joining chunks so per-chunk trimming cannot erase spacing.
    if (part?.type === 'text' && typeof part.text === 'string') {
      pendingAssistantText.push(part.text)
    }
    return
  }
  // Collapse streamed text chunks into one preview per assistant turn.
  if (event.type === 'step.end') {
    flushAssistant()
  }
}

// Sum turn usage buckets; ignore session-scoped totals to avoid double-counting cumulative usage.
function kimiUsageTotal(value: unknown, usageScope: unknown): number {
  if (usageScope === 'session') {
    return 0
  }
  const usage = asRecord(value)
  if (!usage) {
    return 0
  }
  return (
    numberValue(usage.inputOther) +
    numberValue(usage.output) +
    numberValue(usage.inputCacheRead) +
    numberValue(usage.inputCacheCreation)
  )
}
