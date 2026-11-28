import type { ProviderRelayAckFloor } from '../../provider-relay/relayed-provider-output'
import { AcpRelayAckFloor, type AcpInheritedCut } from './acp-relay-ack-floor'
import { AcpRelayItemContinuation } from './acp-relay-item-continuation'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A relayed ACP agent's prompt turns, as the app sends, adopts and settles its prompts, read by
 * each attach's ack floor. A prompt's end that a newer prompt already superseded changes nothing.
 */
export class AcpRelayTurns {
  private running = false
  private serial = 0
  private current: AcpRelayAckFloor | null = null
  /** The running prompt's request id. */
  private promptId: number | null = null
  /** Told when no turn running at an attach can resume: an agent turn's end, a send, an answer. */
  onAgentTurnOver: (() => void) | null = null

  /** A fresh floor for each attach, holding a prompt that runs across it. */
  readonly ackFloor = (): ProviderRelayAckFloor => {
    this.current = new AcpRelayAckFloor(this.running)
    if (this.running && this.promptId !== null) {
      this.current.promptId = this.promptId
    }
    return this.current
  }

  /** A prompt sent by `send` (or an earlier app's one, `adopted`) runs until its answer or failure;
   *  `send` names its request id, so the floor knows the answer line that ends it. */
  track<T>(send: (onId: (id: number) => void) => Promise<T>, adopted = false): Promise<T> {
    const serial = ++this.serial
    this.running = true
    this.current?.startTurn(adopted)
    if (!adopted) {
      this.onAgentTurnOver?.()
    }
    const end = (): void => {
      if (serial === this.serial && this.running) {
        this.running = false
        this.current?.endTurn(true)
        this.onAgentTurnOver?.()
      }
    }
    const answered = send((id) => {
      if (serial === this.serial) {
        this.promptId = id
        if (this.current) {
          this.current.promptId = id
        }
      }
    })
    void answered.then(end, end)
    return answered
  }

  /** Cuts an earlier attach named, for this attach's floor (see `inheritCuts`). */
  readonly inheritCuts = (
    cuts: readonly AcpInheritedCut[],
    overflow: boolean,
    savedThrough: number,
    openChildren?: readonly string[]
  ): void => this.current?.inheritCuts(cuts, overflow, savedThrough, openChildren)

  /** The agent's own turn ended (it has no prompt to answer): its messages no longer hold acks,
   *  so a reattach doesn't replay them into a turn of their own again. */
  readonly agentTurnEnded = (): void => {
    if (!this.running) {
      this.current?.endAgentTurn()
      this.onAgentTurnOver?.()
    }
  }

  /** Every session update's params the connection parsed: a call's final status lets the floor
   *  past it. Acks follow the save barrier, so the parse is in before the floor is next read. */
  observeSessionUpdate(params: unknown): void {
    const update = isRecord(params) ? params.update : undefined
    if (
      isRecord(update) &&
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
      (update.status === 'completed' || update.status === 'failed') &&
      typeof update.toolCallId === 'string'
    ) {
      this.current?.endCall(update.toolCallId)
    }
  }
}

/** One relayed agent's ack floors and its replay continuation, wired so each attach's floor
 *  carries on the cuts the last one named. */
export function acpRelayFloors(childSessions: boolean) {
  const turns = new AcpRelayTurns()
  const continuation = new AcpRelayItemContinuation(childSessions, turns.inheritCuts)
  turns.onAgentTurnOver = () => continuation.agentTurnEnded()
  const ackFloor = () => {
    continuation.reset()
    return turns.ackFloor()
  }
  return { turns, continuation, ackFloor }
}
