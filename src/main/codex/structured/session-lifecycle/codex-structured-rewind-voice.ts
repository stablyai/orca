import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { CodexRealtimeVoice } from '../realtime/codex-realtime-voice'
import { prepareCodexRewind, rewindCodexSession } from '../threads/codex-structured-rewind'
import { requireLiveCodexSession, type CodexSession } from './codex-structured-session-state'
import { recoverCodexRewindAtStart } from './codex-structured-start-verdict'

type Adapter = Required<
  Pick<
    StructuredAgentSessionAdapter,
    'prepareRewind' | 'rewind' | 'recoverRewind' | 'startVoiceConversation'
  >
>

/** Rewind undoes turns but keeps the thread, so Voice mode forgets what it heard there, ends a
 *  call that heard it, and refuses new calls until Codex has settled the revert. */
export function codexRewindsForgettingVoice(
  sessions: Map<string, CodexSession>,
  voice: Pick<CodexRealtimeVoice, 'forget' | 'start'>,
  timeoutMs: () => number | undefined
): {
  prepare: Adapter['prepareRewind']
  rewind: Adapter['rewind']
  recover: Adapter['recoverRewind']
  startVoice: Adapter['startVoiceConversation']
} {
  const rewinding = new Map<string, number>()
  const forget = ({ sessionId, threadId }: { sessionId: string; threadId?: string }) =>
    voice.forget(sessionId, threadId ?? sessions.get(sessionId)?.threadId)
  const holding = async <T>(
    input: { sessionId: string; threadId?: string },
    run: () => Promise<T>
  ): Promise<T> => {
    rewinding.set(input.sessionId, (rewinding.get(input.sessionId) ?? 0) + 1)
    try {
      forget(input)
      return await run()
    } finally {
      const left = (rewinding.get(input.sessionId) ?? 1) - 1
      if (left > 0) {
        rewinding.set(input.sessionId, left)
      } else {
        rewinding.delete(input.sessionId)
      }
    }
  }
  return {
    // A refused preflight changes nothing, so the call and what it heard stay.
    prepare: async (input) => {
      const admission = await prepareCodexRewind(
        requireLiveCodexSession(sessions, input.sessionId),
        input,
        timeoutMs()
      )
      if (admission.ok) {
        forget(input)
      }
      return admission
    },
    rewind: (input) =>
      holding(input, () =>
        rewindCodexSession(requireLiveCodexSession(sessions, input.sessionId), input, timeoutMs())
      ),
    recover: (input) =>
      holding(input, () => recoverCodexRewindAtStart(sessions, input, timeoutMs())),
    startVoice: (input) => {
      if (rewinding.has(input.sessionId)) {
        input.emit({ type: 'refused', reason: 'busy' })
        return { stop: () => {} }
      }
      return voice.start(sessions.get(input.sessionId), input)
    }
  }
}
