import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { AGENT_SESSION_VOICE_NAME_PATTERN } from '../../../../shared/agent-session/agent-session-voice-conversation'

const REQUEST_TIMEOUT_MS = 15_000

/** Orca always starts v3; a Codex without a v3 list cannot take a voice choice. */
export async function listV3Voices(connection: CodexAppServerConnection): Promise<string[] | null> {
  const listing = readRecord(
    readRecord(
      await connection.request('thread/realtime/listVoices', {}, { timeoutMs: REQUEST_TIMEOUT_MS })
    ).voices
  )
  if (!Array.isArray(listing.v3)) {
    return null
  }
  return listing.v3.filter(
    (voice): voice is string =>
      typeof voice === 'string' && AGENT_SESSION_VOICE_NAME_PATTERN.test(voice)
  )
}

/** The preferred voice when this child offers it; a failed listing falls back to the default. */
export async function offeredVoice(
  connection: CodexAppServerConnection,
  voice: string | undefined
): Promise<string | undefined> {
  if (!voice) {
    return undefined
  }
  const voices = await listV3Voices(connection).catch(() => null)
  return voices?.includes(voice) ? voice : undefined
}
