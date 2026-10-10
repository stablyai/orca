import type { RealtimeResponseGate } from './realtime-response-gate'
import { asWireRecord } from './realtime-wire-record'

/**
 * Relays one agent's reply as a spoken coordinator utterance. Sequence per reply:
 * conversation.item.create → gated response.create with a per-response instructions
 * override (the compliance mechanism — an in-band "read this" prefix gets acknowledged
 * ("Okay.") instead of spoken; the override does not).
 *
 * The injected item is a system-role message — the one shape live-proven to reach the
 * model (otto#4297). A function_call_output with a fabricated call_id does NOT: the
 * coordinator answered relays with "still waiting for their replies" while the results
 * sat in the transcript panel (the item never entered its context). The injection
 * boundary is preserved without the role choice: the text keeps our "System note —"
 * framing, the override constrains the relay turn, and the coordinator prompt forbids
 * acting on instructions found inside an agent's reply.
 *
 * No voice dance: the provider locks a session's voice once the model has spoken
 * ("Voice cannot be changed during the session once the model has responded with audio
 * at least once" — the realtime session spec), so session.update voice swaps are dead
 * letter. per-agent mode names the reporter in the relay instructions instead.
 *
 * The settle is correlated, not timed: it arms when the provider's response.created
 * echoes this create's ref and fires on that response's done — so an unrelated
 * in-flight ack's done can't settle the wrong pane, and a barge-in-cancelled reply
 * still settles (the provider sends response.done for cancelled responses too).
 */

export type AgentReplyForSpeech = {
  paneKey: string
  spokenName: string
  text: string
  /** false = relay with no agent name (system-origin notes); default names the agent. */
  attribute?: boolean
}

/**
 * Per-response overrides — the compliance mechanism, kept out of the agent-text item.
 * No example phrasing in either one: the model parrots it verbatim (live: a relay that
 * opened with the literal example "oak reports:" instead of the reporter's name).
 */
const RELAY_INSTRUCTIONS =
  'A system note just arrived with an update on work you kicked off. Relay it to the user in first person as your own follow-through — brief, natural, no "the agent says" framing — then stop.'
const RELAY_INSTRUCTIONS_ATTRIBUTED =
  'A system note just arrived with an update on work you kicked off. Relay it to the user briefly and naturally, leading with the name of the agent the note says reported — then stop.'

export class ReplySpeechSequencer {
  /** Ref of the in-flight reply create whose response has not started yet. */
  private pendingReplyRef: string | null = null
  private pendingReplyPaneKey: string | null = null
  /** Response id whose done settles the speaking pane's chip. */
  private armedResponseId: string | null = null
  private armedPaneKey: string | null = null

  constructor(
    private readonly gate: RealtimeResponseGate,
    /** per-agent mode: relays name the reporter instead of first-person follow-through. */
    private readonly nameAgents: () => boolean,
    /** Fires when a reply's response is done (or its arm is superseded) — chips clear on it. */
    private readonly onReplySettled?: (paneKey: string) => void
  ) {}

  speak(reply: AgentReplyForSpeech): void {
    const namesAgent = reply.attribute !== false
    this.gate.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: namesAgent
              ? `System note — an update from ${reply.spokenName}, whose work you kicked off: ${reply.text}`
              : `System note — an update on work you kicked off: ${reply.text}`
          }
        ]
      }
    })
    const created = this.gate.sendEvent({
      type: 'response.create',
      response: {
        instructions:
          namesAgent && this.nameAgents() ? RELAY_INSTRUCTIONS_ATTRIBUTED : RELAY_INSTRUCTIONS
      }
    })
    // A newer speak() supersedes an older pending arm — its settle belongs to the reply
    // actually playing, and the superseded pane's chip settles here so it can't linger.
    if (this.pendingReplyPaneKey !== null && this.pendingReplyPaneKey !== reply.paneKey) {
      this.onReplySettled?.(this.pendingReplyPaneKey)
    }
    this.pendingReplyRef = created?.ref ?? null
    this.pendingReplyPaneKey = created ? reply.paneKey : null
  }

  /** Feed every inbound sideband event. */
  observe(event: Record<string, unknown>): void {
    if (event.type === 'response.created' && this.pendingReplyRef !== null) {
      const response = asWireRecord(event.response)
      const ref = asWireRecord(response?.metadata)?.ref
      if (ref === this.pendingReplyRef && typeof response?.id === 'string') {
        this.armedResponseId = response.id
        this.armedPaneKey = this.pendingReplyPaneKey
        this.pendingReplyRef = null
        this.pendingReplyPaneKey = null
      }
      return
    }
    if (event.type === 'response.done' && this.armedResponseId !== null) {
      if (asWireRecord(event.response)?.id !== this.armedResponseId) {
        return
      }
      this.armedResponseId = null
      if (this.armedPaneKey !== null) {
        this.onReplySettled?.(this.armedPaneKey)
        this.armedPaneKey = null
      }
    }
  }

  /** Session teardown disarms without sending; the socket is already gone. */
  disarm(): void {
    this.pendingReplyRef = null
    this.armedResponseId = null
  }
}
