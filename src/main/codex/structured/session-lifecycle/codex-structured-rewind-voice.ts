import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { CodexRealtimeVoice } from '../realtime/codex-realtime-voice'
import { prepareCodexRewind, rewindCodexSession } from '../threads/codex-structured-rewind'
import { requireLiveCodexSession, type CodexSession } from './codex-structured-session-state'
import { recoverCodexRewindAtStart } from './codex-structured-start-verdict'

type Adapter = Required<
  Pick<StructuredAgentSessionAdapter, 'prepareRewind' | 'rewind' | 'recoverRewind'>
>

/** Rewind undoes turns but keeps the thread, so Voice mode forgets what it heard there, and ends a
 *  call that heard it, before Codex reverts anything. */
export function codexRewindsForgettingVoice(
  sessions: Map<string, CodexSession>,
  voice: Pick<CodexRealtimeVoice, 'forget'>,
  timeoutMs: () => number | undefined
): {
  prepare: Adapter['prepareRewind']
  rewind: Adapter['rewind']
  recover: Adapter['recoverRewind']
} {
  const forget = ({ sessionId, threadId }: { sessionId: string; threadId?: string }) => {
    voice.forget(sessionId, threadId ?? sessions.get(sessionId)?.threadId)
    return sessions
  }
  const live = (input: { sessionId: string }) =>
    requireLiveCodexSession(forget(input), input.sessionId)
  return {
    prepare: (input) => prepareCodexRewind(live(input), input, timeoutMs()),
    rewind: (input) => rewindCodexSession(live(input), input, timeoutMs()),
    recover: (input) => recoverCodexRewindAtStart(forget(input), input, timeoutMs())
  }
}
