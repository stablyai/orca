import {
  decodeTerminalStreamFrameHeader,
  TerminalStreamOpcode
} from '../../shared/terminal-stream-protocol'
import {
  TerminalStreamProgress,
  terminalStreamProgressReporter,
  type TerminalStreamProgressReporter
} from '../observability/terminal-stream-progress'

type SubscriptionIdentity = {
  requestId: string
  environmentId: string
  method: string
}

export type TerminalSendOutcome =
  | 'accepted'
  | 'ipc_subscription_missing'
  | 'ipc_owner_mismatch'
  | 'ipc_transport_refused'

export const TERMINAL_SEND_PROGRESS_MAX_STREAMS = 128

export class TerminalSubscriptionSendProgress {
  private readonly streams = new Map<string, TerminalStreamProgress>()
  private evictedStreamRecords = 0

  constructor(private readonly reporter: TerminalStreamProgressReporter) {}

  record(
    subscriptionId: string,
    subscription: SubscriptionIdentity | undefined,
    bytes: Uint8Array,
    outcome: TerminalSendOutcome
  ): void {
    if (subscriptionId.length > 128) {
      return
    }
    if (subscription && subscription.method !== 'terminal.multiplex') {
      return
    }
    const frame = decodeTerminalStreamFrameHeader(bytes)
    if (!frame || (frame.opcode !== TerminalStreamOpcode.Input && frame.opcode !== TerminalStreamOpcode.Ack)) {
      return
    }
    const key = `${subscriptionId}:${frame.streamId}`
    let progress = this.streams.get(key)
    if (progress && subscription && progress.identity.requestId !== subscription.requestId) {
      progress.dispose()
      this.streams.delete(key)
      progress = undefined
    }
    if (!progress) {
      if (this.streams.size >= TERMINAL_SEND_PROGRESS_MAX_STREAMS) {
        const oldest = this.streams.entries().next().value
        if (oldest) {
          oldest[1].dispose()
          this.streams.delete(oldest[0])
          this.evictedStreamRecords += 1
        }
      }
      progress = new TerminalStreamProgress(
        this.reporter,
        {
          side: 'client',
          subscriptionId,
          streamId: frame.streamId,
          ...(subscription
            ? { requestId: subscription.requestId, environmentId: subscription.environmentId }
            : {})
        },
        () => ({ evictedStreamRecords: this.evictedStreamRecords })
      )
      this.streams.set(key, progress)
    }
    if (frame.opcode === TerminalStreamOpcode.Input) {
      progress.count(outcome === 'accepted' ? 'ipcInputAccepted' : 'ipcInputRefused')
    } else {
      progress.count(outcome === 'accepted' ? 'ipcAckAccepted' : 'ipcAckRefused')
    }
    if (outcome !== 'accepted') {
      progress.report(outcome)
    }
  }

  dispose(): void {
    for (const progress of this.streams.values()) {
      progress.dispose()
    }
    this.streams.clear()
    this.evictedStreamRecords = 0
  }
}

export const terminalSubscriptionSendProgress = new TerminalSubscriptionSendProgress(
  terminalStreamProgressReporter
)
