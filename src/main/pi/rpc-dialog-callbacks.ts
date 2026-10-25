import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { JsonlRpcTimelineLane } from '../jsonl-rpc/timeline-lane'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import { piRpcDialogPresentation, type PiRpcDialogPresentation } from './rpc-extension-dialogs'

type Callback = { presentation: PiRpcDialogPresentation; claimed: boolean; bytes: number }
const DECORATION = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'setEditorText'])

export class PiRpcDialogCallbacks {
  private readonly pending = new Map<string, Callback>()
  private pendingBytes = 0
  constructor(
    private readonly lane: JsonlRpcTimelineLane,
    private readonly send: (frame: JsonlRpcRecord) => Promise<void>,
    private readonly onFailed: (error: Error) => void
  ) {}

  receive(frame: JsonlRpcRecord): void {
    if (typeof frame.method === 'string' && DECORATION.has(frame.method)) {
      return
    }
    const presentation = piRpcDialogPresentation(frame)
    if (!presentation) {
      if (typeof frame.id === 'string' || typeof frame.id === 'number') {
        void this.send({ type: 'extension_ui_response', id: frame.id, cancelled: true }).catch(
          (error: unknown) =>
            this.onFailed(error instanceof Error ? error : new Error(String(error)))
        )
      }
      return
    }
    const key = String(presentation.id)
    const bytes = Buffer.byteLength(JSON.stringify(presentation.body))
    if (
      this.pending.has(key) ||
      this.pending.size >= 64 ||
      this.pendingBytes + bytes > 8 * 1024 * 1024
    ) {
      throw new Error('Pi dialog identity or capacity violation')
    }
    this.pending.set(key, { presentation, claimed: false, bytes })
    this.pendingBytes += bytes
    this.lane.apply([{ type: 'request.open', request: key, body: presentation.body }])
  }

  async respond(
    itemId: string,
    response: AgentSessionPromptResponse | null,
    commit: () => Promise<void>,
    answer = true
  ): Promise<void> {
    const entry = [...this.pending].find(([key]) => this.lane.isRequestRow(itemId, key))
    if (!entry || entry[1].claimed) {
      throw new AgentSessionPromptUnavailableError(itemId)
    }
    const [key, callback] = entry
    let reply: Record<string, unknown>
    try {
      reply = callback.presentation.reply(response)
    } catch (error) {
      throw new AgentSessionPromptAnswerRejectedError(
        error instanceof Error ? error.message : 'Invalid Pi dialog answer'
      )
    }
    callback.claimed = true
    try {
      await commit()
      if (this.pending.get(key) !== callback) {
        throw new AgentSessionPromptUnavailableError(itemId)
      }
      if (answer) {
        await this.send({ type: 'extension_ui_response', id: callback.presentation.id, ...reply })
      }
      this.pending.delete(key)
      this.pendingBytes -= callback.bytes
    } catch (error) {
      callback.claimed = false
      throw error
    }
  }

  cancelAll(): void {
    for (const [key, callback] of this.pending) {
      this.lane.apply([{ type: 'request.withdrawn', request: key }])
      void this.send({
        type: 'extension_ui_response',
        id: callback.presentation.id,
        cancelled: true
      }).catch(() => {})
    }
    this.pending.clear()
    this.pendingBytes = 0
  }
}
