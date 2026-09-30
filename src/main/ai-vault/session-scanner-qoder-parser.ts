import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import {
  addPreviewMessage,
  accumulatorSessionIdentity,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateLatestLocation,
  updateTimeline
} from './session-scanner-accumulator'
import {
  asRecord,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export type QoderSessionParseState = {
  accumulator: SessionAccumulator
  firstUserTitle: string | null
}

export function createQoderSessionParseState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): QoderSessionParseState {
  const extractedSessionId = sessionIdFromFileName(file.path)
  const initialAccumulator = createAccumulator({
    agent: 'qoder',
    file,
    sessionId: extractedSessionId,
    messages
  })
  return {
    accumulator: initialAccumulator,
    firstUserTitle: null
  }
}

export function cloneQoderSessionParseState(state: QoderSessionParseState): QoderSessionParseState {
  return {
    accumulator: {
      ...state.accumulator,
      previewMessages: [...state.accumulator.previewMessages]
    },
    firstUserTitle: state.firstUserTitle
  }
}

function extractTextFromBlocks(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (!Array.isArray(content)) {
    return null
  }
  const textSegments = content
    .map((block) => {
      const blockRecord = asRecord(block)
      const blockType = extractString(blockRecord?.type)
      if (blockType === 'text') {
        const textValue = extractString(blockRecord?.text)
        return textValue ? textValue.trim() : null
      }
      return null
    })
    .filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)

  return textSegments.length > 0 ? textSegments.join('\n') : null
}

export function consumeQoderSessionLine(state: QoderSessionParseState, lineString: string): void {
  const lineRecord = parseJsonObject(lineString)
  if (!lineRecord) {
    return
  }

  const accumulator = state.accumulator
  const rawSessionId = extractString(lineRecord.sessionId)
  if (rawSessionId) {
    accumulator.sessionId = rawSessionId.trim()
  }

  const recordTimestamp = extractString(lineRecord.timestamp)
  updateTimeline(accumulator, recordTimestamp)
  updateLatestLocation(accumulator, lineRecord)

  const recordType = extractString(lineRecord.type)
  if (recordType === 'workspace-directories') {
    const rawDirectories = lineRecord.directories
    if (Array.isArray(rawDirectories) && rawDirectories.length > 0 && !accumulator.cwd) {
      const firstDirectory = extractString(rawDirectories[0])
      if (firstDirectory) {
        accumulator.cwd = firstDirectory
      }
    }
    return
  }

  const messageRecord = asRecord(lineRecord.message)
  if (!messageRecord) {
    return
  }

  const role = extractString(messageRecord.role)
  const validText = extractTextFromBlocks(messageRecord.content)
  if (!validText) {
    return
  }

  const messageTimestamp = recordTimestamp ?? ''
  if (role === 'user') {
    if (!state.firstUserTitle) {
      state.firstUserTitle = normalizeTitleText(validText)
      accumulator.fallbackTitle = state.firstUserTitle
    }
    accumulator.messageCount++
    addPreviewMessage(accumulator, { role: 'user', text: validText, timestamp: messageTimestamp })
  } else if (role === 'assistant') {
    accumulator.messageCount++
    addPreviewMessage(accumulator, {
      role: 'assistant',
      text: validText,
      timestamp: messageTimestamp
    })
  }
}

export function finalizeQoderSessionParseState(
  state: QoderSessionParseState,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {}
): AiVaultSession | null {
  const snapshotState = cloneQoderSessionParseState(state)
  snapshotState.accumulator.fallbackTitle = snapshotState.firstUserTitle ?? 'Untitled Qoder Session'
  return finalizeSession(snapshotState.accumulator, platform, options)
}

function qoderResumeStateFromParseState(state: QoderSessionParseState): ResumableSessionParseState {
  return {
    consumeLine: (lineString) => consumeQoderSessionLine(state, lineString),
    identity: () => accumulatorSessionIdentity(state.accumulator),
    clone: () => qoderResumeStateFromParseState(cloneQoderSessionParseState(state)),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options) => finalizeQoderSessionParseState(state, platform, options)
  }
}

export function createQoderSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  const parseState = createQoderSessionParseState(file, messages)
  return qoderResumeStateFromParseState(parseState)
}

export async function parseQoderSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const readStream = openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan')
  const lineInterface = createInterface({
    input: readStream,
    crlfDelay: Infinity
  })

  const parseState = createQoderSessionParseState(file, messages)
  for await (const currentLine of lineInterface) {
    consumeQoderSessionLine(parseState, currentLine)
  }

  return finalizeQoderSessionParseState(parseState, platform)
}
