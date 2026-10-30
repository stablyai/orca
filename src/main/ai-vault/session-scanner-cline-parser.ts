import { isMissingRemoteSessionPathError } from './remote-session-file-stat'
import { BinarySessionTranscriptError } from './remote-session-content-lines'
import { readStreamedSessionDocument } from './session-document-stream'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { clineMessagesPathForMetadata } from '../../shared/ai-vault-session-log-resource'
import type { ExecutionHostId } from '../../shared/execution-host'
import { createAccumulator, finalizeSession, updateTimeline } from './session-scanner-accumulator'
import { addSessionContent } from './session-scanner-messages'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  arrayValue,
  asRecord,
  extractContentText,
  extractString,
  normalizeTitleText
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

export function isClineSessionMetadataPath(filePath: string): boolean {
  const segments = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  const fileName = segments.pop()
  const sessionId = segments.pop()
  return Boolean(fileName && sessionId && fileName === `${sessionId}.json`)
}

export { clineMessagesPathForMetadata }

export async function parseClineSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messageSink?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseClineSessionDocuments(
    file,
    openTranscriptReadStream(file.path, {}, 'scan'),
    () => openTranscriptReadStream(clineMessagesPathForMetadata(file.path), {}, 'scan'),
    platform,
    {},
    signal,
    messageSink
  )
}

export function clineManifestCwd(metadataContent: string): string | null {
  const metadata = parseJsonRecord(metadataContent)
  return metadata ? clineMetadataCwd(metadata) : null
}

function clineMetadataCwd(metadata: Record<string, unknown>): string | null {
  return extractString(metadata.cwd) ?? extractString(metadata.workspace_root)
}

export function parseClineSessionContent(
  file: FileWithMtime,
  metadataContent: string,
  messagesContent: string | null,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  messageSink?: TranscriptMessageSink
): AiVaultSession | null {
  const metadata = parseJsonRecord(metadataContent)
  if (!metadata) {
    return null
  }
  const pathSegments = file.path.replace(/\\/g, '/').split('/').filter(Boolean)
  const sessionId = extractString(metadata.session_id) ?? pathSegments.at(-2) ?? ''
  const accumulator = createAccumulator({
    agent: 'cline',
    file,
    sessionId,
    messages: messageSink
  })
  accumulator.cwd = clineMetadataCwd(metadata)
  accumulator.model = extractString(metadata.model)
  updateTimeline(accumulator, metadata.started_at)

  const messages = messagesContent ? parseJsonRecord(messagesContent) : null
  if (messages) {
    updateTimeline(accumulator, messages.updated_at)
    for (const value of arrayValue(messages.messages)) {
      consumeClineSessionMessage(accumulator, value)
    }
  }
  accumulator.fallbackTitle ??= normalizeTitleText(extractString(metadata.prompt) ?? '')

  return finalizeSession(accumulator, platform, options)
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(content) as unknown)
  } catch {
    return null
  }
}

function consumeClineSessionMessage(accumulator: SessionAccumulator, value: unknown): void {
  const message = asRecord(value)
  const role = message?.role
  if (!message || (role !== 'user' && role !== 'assistant')) {
    return
  }
  accumulator.messageCount++
  updateTimeline(accumulator, message.ts)
  const content = message.content
  if (role === 'user' && !accumulator.fallbackTitle) {
    accumulator.fallbackTitle = normalizeTitleText(extractContentText(content) ?? '')
  }
  if (role === 'assistant' && !accumulator.model) {
    accumulator.model = extractString(asRecord(message.modelInfo)?.id)
  }
  addSessionContent(accumulator, role, content, message.ts)
}

export async function parseClineSessionDocuments(
  file: FileWithMtime,
  metadataBytes: AsyncIterable<Buffer>,
  readMessages: () => AsyncIterable<Buffer>,
  platform: NodeJS.Platform,
  options: ParserSessionOptions,
  signal?: AbortSignal,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  let metadata: Record<string, unknown>
  try {
    const parsed = await readStreamedSessionDocument({
      bytes: metadataBytes,
      arrayKey: '',
      fields: ['session_id', 'cwd', 'workspace_root', 'model', 'started_at', 'prompt'],
      create: () => null,
      consume: () => {},
      signal
    })
    if (!parsed) {
      return null
    }
    metadata = parsed.record
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
  const create = (): SessionAccumulator => {
    messages?.reset?.()
    const pathSegments = file.path.replace(/\\/g, '/').split('/').filter(Boolean)
    const accumulator = createAccumulator({
      agent: 'cline',
      file,
      sessionId: extractString(metadata.session_id) ?? pathSegments.at(-2) ?? '',
      messages
    })
    accumulator.cwd = extractString(metadata.cwd) ?? extractString(metadata.workspace_root)
    accumulator.model = extractString(metadata.model)
    updateTimeline(accumulator, metadata.started_at)
    return accumulator
  }
  let accumulator = create()
  try {
    const parsed = await readStreamedSessionDocument({
      bytes: readMessages(),
      arrayKey: 'messages',
      fields: ['updated_at'],
      create,
      consume: consumeClineSessionMessage,
      signal
    })
    if (parsed) {
      accumulator = parsed.state
      updateTimeline(accumulator, parsed.record.updated_at)
    }
  } catch (error) {
    if (
      error instanceof WslTranscriptFsError ||
      (!(error instanceof SyntaxError) &&
        !(error instanceof BinarySessionTranscriptError) &&
        !isMissingRemoteSessionPathError(error))
    ) {
      throw error
    }
    messages?.reset?.()
  }
  accumulator.fallbackTitle ??= normalizeTitleText(extractString(metadata.prompt) ?? '')
  return finalizeSession(accumulator, platform, options)
}
