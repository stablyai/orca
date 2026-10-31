import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import type { NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { asRecord, parseJsonObject, timestampMs } from '../ai-vault/session-scanner-values'
import { isENOENT } from '../ipc/filesystem/filesystem-path-containment'
import { splitTranscriptStreamLines } from './transcript-stream-lines'

/** Grok writes turn boundaries beside its transcript, in the session's events log. */
export async function readGrokTurnLifecycle(
  filePath: string,
  sessionId: string
): Promise<NativeChatTurnLifecycle | undefined> {
  let latest: NativeChatTurnLifecycle | undefined
  try {
    for await (const { line } of splitTranscriptStreamLines(
      createReadStream(join(dirname(filePath), 'events.jsonl')),
      16 * 1024 * 1024
    )) {
      const event = asRecord(parseJsonObject(line))
      const parsed = timestampMs(event?.ts)
      const timestamp = Number.isFinite(parsed) ? parsed : null
      if (event?.type === 'turn_started') {
        latest =
          event.session_id === sessionId && typeof event.turn_number === 'number'
            ? {
                state: 'working',
                turnId: `grok:${event.turn_number}:${String(event.ts)}`,
                timestamp
              }
            : undefined
      } else if (event?.type === 'turn_ended' && latest) {
        const state =
          event.outcome === 'completed'
            ? 'completed'
            : event.outcome === 'error'
              ? 'failed'
              : event.outcome === 'cancelled' || event.outcome === 'interrupted'
                ? 'interrupted'
                : null
        if (state) {
          latest = {
            turnId: latest.turnId,
            state: state === 'failed' ? 'completed' : state,
            timestamp,
            ...(state === 'failed' ? { outcome: 'failure' as const } : {})
          }
        }
      }
    }
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }
  return latest
}
