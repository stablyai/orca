import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenInput } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import { codexStartFailure } from './app-server/codex-startup-outcome'
import { recoverCodexRewind } from './codex-structured-rewind'
import {
  requireLiveCodexSession,
  type CodexAcquisitionRegistry,
  type CodexSession
} from './codex-structured-session-state'

/** A start's open answers with Codex's verdict; a child that already ended answers with how it
 *  ended, and an answer its own exit followed is still worded as that exit. */
export function openCodexStart(
  acquisitions: CodexAcquisitionRegistry,
  input: StructuredAgentSessionProviderOpenInput
): ReturnType<StructuredAgentSessionAdapter['open']> {
  const attempt = acquisitions.get(input.sessionId)
  const opening = attempt?.open
    ? attempt.open(input)
    : Promise.reject(
        acquisitions.endings.get(input.sessionId, input.acquisitionGeneration) ??
          new Error(`no spawned codex child for session ${input.sessionId}`)
      )
  return opening.catch((error: unknown) => {
    const exited = attempt?.exitProven === true && !attempt.cancelled
    throw codexStartFailure([error, exited ? attempt?.exitError : undefined], exited)
  })
}

/** A start reads this before it is ready, so its failure carries Codex's verdict. */
export async function recoverCodexRewindAtStart(
  sessions: Map<string, CodexSession>,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>>[0],
  timeoutMs?: number
): ReturnType<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>> {
  try {
    return await recoverCodexRewind(
      requireLiveCodexSession(sessions, input.sessionId),
      input,
      timeoutMs
    )
  } catch (error) {
    throw codexStartFailure(error)
  }
}
