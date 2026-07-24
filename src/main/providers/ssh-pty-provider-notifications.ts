import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type {
  SshPtyDataCallback,
  SshPtyExitCallback,
  SshPtyReplayCallback
} from './ssh-pty-provider-contract'
import { SshPtyOutputDeliveryCredit } from './ssh-pty-output-delivery-credit'
import { isAdmittedSshRelayPtyId } from './ssh-pty-wire-admission'

export class SshPtyProviderNotifications {
  private readonly dataListeners = new Set<SshPtyDataCallback>()
  private readonly replayListeners = new Set<SshPtyReplayCallback>()
  private readonly exitListeners = new Set<SshPtyExitCallback>()
  private readonly outputDeliveryCredit: SshPtyOutputDeliveryCredit
  private unsubscribe: (() => void) | null

  constructor(
    mux: SshChannelMultiplexer,
    private readonly toAppPtyId: (relayId: string) => string,
    recordNotification: (relayId: string) => void,
    recordExit: (relayId: string, incarnationId: unknown) => void
  ) {
    this.outputDeliveryCredit = new SshPtyOutputDeliveryCredit((params) => {
      mux.notify('pty.ackData', params)
    })
    this.unsubscribe = mux.onNotification((method, params) => {
      const relayId = params.id
      if (!isAdmittedSshRelayPtyId(relayId)) {
        return
      }
      switch (method) {
        case 'pty.data':
          this.emitData(params, recordNotification)
          break
        case 'pty.replay': {
          if (typeof params.data !== 'string') {
            return
          }
          recordNotification(relayId)
          for (const listener of this.replayListeners) {
            listener({
              id: this.toAppPtyId(relayId),
              data: params.data
            })
          }
          break
        }
        case 'pty.exit': {
          const code = params.code
          const incarnationId = params.incarnationId
          if (
            typeof code !== 'number' ||
            !Number.isSafeInteger(code) ||
            (incarnationId !== undefined && !isPtyIncarnationId(incarnationId))
          ) {
            return
          }
          this.outputDeliveryCredit.release(relayId)
          recordExit(relayId, incarnationId)
          for (const listener of this.exitListeners) {
            listener({
              id: this.toAppPtyId(relayId),
              code,
              ...(isPtyIncarnationId(incarnationId) ? { incarnationId } : {})
            })
          }
          break
        }
      }
    })
  }

  private emitData(
    params: Record<string, unknown>,
    recordNotification: (relayId: string) => void
  ): void {
    this.outputDeliveryCredit.ingest(params, (output) => {
      recordNotification(output.relayId)
      if (this.dataListeners.size === 0) {
        output.upstreamCredit?.acknowledge(output.upstreamCredit.charCount)
        return
      }
      for (const listener of this.dataListeners) {
        listener({
          id: this.toAppPtyId(output.relayId),
          data: output.data,
          ...(output.rawLength === undefined ? {} : { sequenceChars: output.rawLength }),
          ...(output.transformed ? { transformed: true } : {}),
          ...(output.seq === undefined ? {} : { seq: output.seq }),
          ...(output.upstreamCredit ? { upstreamCredit: output.upstreamCredit } : {})
        })
      }
    })
  }

  acknowledgeLegacy(relayId: string, charCount: number): void {
    this.outputDeliveryCredit.acknowledgeLegacy(relayId, charCount)
  }

  onData(callback: SshPtyDataCallback): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(callback: SshPtyReplayCallback): () => void {
    this.replayListeners.add(callback)
    return () => this.replayListeners.delete(callback)
  }

  onExit(callback: SshPtyExitCallback): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.dataListeners.clear()
    this.replayListeners.clear()
    this.exitListeners.clear()
    this.outputDeliveryCredit.dispose()
  }
}
