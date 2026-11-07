import type { AgentSessionPromptResponse } from '../../../shared/agent-session/agent-session-question-answer'
import '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import type { JsonlRpcRecord } from '../../jsonl-rpc/peer'
import { piRpcDialogPresentation, type PiRpcDialogPresentation } from './rpc-extension-dialogs'
import { PiRpcBackgroundWork } from './background-work/rpc-background-work'
import { PiRpcNativeWorkers, type PiRpcNativeWorkersDeps } from './rpc-native-workers'
import type { PiRpcSession } from './rpc-session'
import type { PiBackgroundWorkLaunch } from './background-work/rpc-background-work-bridge'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'

type Callback = { presentation: PiRpcDialogPresentation; claimed: boolean; bytes: number }
const DECORATION = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'setEditorText'])

export class PiRpcDialogCallbacks {
  static forSession(
    session: Pick<PiRpcSession, 'lane' | 'connection' | 'input' | 'fail'>,
    deps: PiRpcNativeWorkersDeps & { logger: StructuredAgentSessionLogger },
    backgroundWork: PiBackgroundWorkLaunch | undefined
  ): PiRpcDialogCallbacks {
    const { input } = session
    const workers = new PiRpcNativeWorkers(
      (evidence) => deps.onChildWorkEvidence?.(input.identity.sessionId, evidence, input.events),
      (unavailable) => {
        session.lane.apply([
          {
            type: 'item.update',
            item: 'pi-background-worker-inventory',
            join: { scope: AGENT_JOURNAL_THREAD_SCOPE },
            body: {
              kind: 'status',
              tone: unavailable ? 'warning' : 'info',
              text: unavailable
                ? 'Pi background worker inventory unavailable or partial. Active background worker count is unknown. A compatible pi-subagents package and a complete status snapshot are required; foreground workers are not observed.'
                : 'Pi background worker inventory recovered. Counts cover confirmed background workers only.'
            }
          }
        ])
        if (unavailable) {
          deps.logger.warn('Pi background worker inventory unavailable or partial', {
            scope: 'pi-native-workers',
            sessionId: input.identity.sessionId
          })
        }
      }
    )
    return new PiRpcDialogCallbacks(
      session.lane,
      (frame) => session.connection.send(frame),
      (error) => session.fail(error),
      backgroundWork?.directory ?? null,
      workers
    )
  }
  private readonly pending = new Map<string, Callback>()
  private pendingBytes = 0
  /** Its frames never reach presentation, the pending cap, or cancelAll at turn end. */
  readonly backgroundWork: PiRpcBackgroundWork
  constructor(
    private readonly lane: JsonlRpcTimelineLane,
    private readonly send: (frame: JsonlRpcRecord) => Promise<void>,
    private readonly onFailed: (error: Error) => void,
    backgroundWorkDirectory: string | null = null,
    readonly nativeWorkers?: PiRpcNativeWorkers
  ) {
    this.backgroundWork = new PiRpcBackgroundWork(backgroundWorkDirectory)
  }

  /** The child exited: its dialogs and any probe awaiting an answer can never be answered. */
  close(): void {
    this.cancelAll()
    this.backgroundWork.end()
    this.nativeWorkers?.end()
  }

  receive(frame: JsonlRpcRecord): void {
    const workerFrame = this.nativeWorkers?.receive(frame)
    if (this.backgroundWork.receive(frame) || workerFrame) {
      return
    }
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
