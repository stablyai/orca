import { nativeChatLineDecoderForAgent } from '../native-chat/transcript-tail-reader'
import { nativeChatTurnLifecycleDecoderForAgent } from '../native-chat/transcript-turn-lifecycle'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TranscriptRecordObservation } from '../native-chat/transcript-watch-contract'

export function createAutomationRunNativeTurnDecoder(agent: TuiAgent) {
  const decode = nativeChatLineDecoderForAgent(agent)
  const lifecycle = nativeChatTurnLifecycleDecoderForAgent(agent)
  if (!decode || !lifecycle) {
    return null
  }
  return (sessionId: string, roots: Map<string, string>) =>
    (
      event: Extract<TranscriptRecordObservation, { kind: 'record' }>,
      legacyCodexRoot: string | null
    ) => {
      const raw = parseJsonObject(event.line)
      if (!raw) {
        return null
      }
      if (raw.isSidechain === true) {
        return null
      }
      const provider = resolveNativeChatTranscriptAgent(agent)
      const message = decode(event.line, `${event.identity}:${event.offset}`)
      const state = lifecycle(event.line, `${event.identity}:${event.offset}`)
      let root: string | null = null
      let inputId: string | null = null
      let committed = false
      let error: string | undefined
      if (provider === 'codex') {
        const payload = asRecord(raw.payload)
        if (raw.type === 'session_meta' && payload?.id !== sessionId) {
          return { invalid: true } as const
        }
        if (raw.type !== 'event_msg' || !payload) {
          return null
        }
        const turn = extractString(payload.turn_id)
        const containing = turn
        if (payload.type === 'task_started' || payload.type === 'turn_started') {
          legacyCodexRoot = containing
        }
        const item = asRecord(payload.item)
        committed =
          payload.type === 'user_message' ||
          (payload.type === 'item_completed' &&
            (item?.type === 'UserMessage' || item?.type === 'user_message'))
        root = containing ?? legacyCodexRoot
        inputId =
          extractString(item?.id) ??
          extractString(payload.id) ??
          `${event.identity}:${event.offset}`
        if (
          payload.type === 'error' ||
          (payload.type === 'task_complete' && payload.error != null)
        ) {
          error = 'The agent reported that this turn failed.'
        }
        if (state && state.state !== 'working' && !turn) {
          root = legacyCodexRoot
        }
      } else if (provider === 'claude') {
        if (typeof raw.sessionId === 'string' && raw.sessionId !== sessionId) {
          return { invalid: true } as const
        }
        const id = extractString(raw.uuid)
        const parent = extractString(raw.parentUuid)
        const inherited = parent ? roots.get(parent) : undefined
        const isOpening = raw.type === 'user' && state?.state === 'working'
        root = isOpening && id ? id : (inherited ?? null)
        if (id && root) {
          roots.set(id, root)
        }
        inputId = id
        committed = message?.role === 'user' && (isOpening || raw.type === 'attachment')
        const stop = asRecord(raw.message)?.stop_reason
        if (
          raw.type === 'assistant' &&
          state?.state === 'completed' &&
          !['end_turn', 'max_tokens', 'stop_sequence', 'refusal'].includes(
            typeof stop === 'string' ? stop : ''
          )
        ) {
          return null
        }
      }

      return { root, inputId, committed, error, message, state, provider, legacyCodexRoot }
    }
}
