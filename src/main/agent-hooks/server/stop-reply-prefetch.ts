import { stat } from 'node:fs/promises'
import {
  hasExplicitLastAssistantResult,
  hasNonEmptyString
} from '../../../shared/agent-hook-listener/grok-result-discovery'
import {
  prefetchHookEventName,
  prefetchHookPayload,
  settlePrefetchWithin
} from '../../../shared/agent-hook-listener/hook-prefetch-queue'
import { readFirstString } from '../../../shared/agent-hook-listener/interactive-tool'
import { isAntigravityStopStillBusy } from '../../../shared/agent-hook-listener/providers/antigravity/antigravity-event-rules'
import {
  normalizeCopilotEventName,
  resolveCopilotEventName
} from '../../../shared/agent-hook-listener/providers/copilot/copilot-tool-fields'
import type { PrefetchedStopReply } from '../../../shared/agent-hook-listener/transcript-lines'
import { readLastAssistantFromTranscriptAsync } from '../../../shared/agent-hook-listener/transcript-reader'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { ASSISTANT_MESSAGE_RETRY_ATTEMPTS, ASSISTANT_MESSAGE_RETRY_MS } from './server-constants'

/** Sources whose Stop falls back to readLastAssistantFromTranscript; Grok reads inline so its chat history keeps losing. */
const STOP_REPLY_TRANSCRIPT_SOURCES: ReadonlySet<AgentHookSource> = new Set<AgentHookSource>([
  'claude',
  'qoder-cn',
  'qwen-code',
  'qoder',
  'codebuddy',
  'kimi',
  'muse',
  'dsh',
  'zcode',
  'devin',
  'antigravity',
  'droid',
  'copilot'
])

/** The transcript a Stop without its reply would have normalize read; mirrors the provider extractors' checks. */
function textlessStopTranscriptPath(source: AgentHookSource, body: unknown): string | undefined {
  if (!STOP_REPLY_TRANSCRIPT_SOURCES.has(source)) {
    return undefined
  }
  const payload = prefetchHookPayload(body)
  if (!payload || hasExplicitLastAssistantResult(payload)) {
    return undefined
  }
  const eventName = prefetchHookEventName(body, payload)
  if (source === 'copilot') {
    const copilotEvent = normalizeCopilotEventName(resolveCopilotEventName(eventName, payload))
    return copilotEvent === 'Stop' && !hasNonEmptyString(payload.message)
      ? readFirstString(payload, ['transcript_path', 'transcriptPath'])
      : undefined
  }
  if (eventName !== 'Stop') {
    return undefined
  }
  return source === 'antigravity'
    ? isAntigravityStopStillBusy(payload)
      ? undefined
      : readFirstString(payload, ['transcriptPath', 'transcript_path'])
    : readFirstString(payload, ['transcript_path'])
}

async function readStopReply(
  transcriptPath: string,
  attempts: number,
  keepReading: () => boolean
): Promise<string | undefined> {
  let scannedSize: number | undefined
  for (let attempt = 1; attempt <= attempts && keepReading(); attempt += 1) {
    const size = await stat(transcriptPath).then(
      (stats) => stats.size,
      () => undefined
    )
    // A transcript that hasn't grown since the last scan would only cost another 4 MiB scan.
    if (size === undefined || size !== scannedSize) {
      scannedSize = size
      const text = await readLastAssistantFromTranscriptAsync(transcriptPath, keepReading)
      if (text) {
        return text
      }
    }
    if (attempt < attempts) {
      // Stop can precede the transcript flush.
      await new Promise((resolve) => setTimeout(resolve, ASSISTANT_MESSAGE_RETRY_MS).unref?.())
    }
  }
  return undefined
}

/** Reads a textless Stop's reply off the event loop before it is normalized; undefined for any other hook. */
export async function prefetchStopReply(
  source: AgentHookSource,
  body: unknown,
  keepReading: () => boolean,
  attempts = ASSISTANT_MESSAGE_RETRY_ATTEMPTS
): Promise<PrefetchedStopReply | undefined> {
  const transcriptPath = textlessStopTranscriptPath(source, body)
  if (!transcriptPath) {
    return undefined
  }
  let closed = false
  let text: string | undefined
  await settlePrefetchWithin(
    readStopReply(transcriptPath, attempts, () => !closed && keepReading()).then((found) => {
      text = found
    })
  )
  closed = true
  return { transcriptPath, text }
}
