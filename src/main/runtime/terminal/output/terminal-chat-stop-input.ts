import {
  parseChatStopInput,
  reportWriteSettlement,
  type WriteSettlementSink
} from '../../../../shared/chat-stop-input'
import type { RuntimeConstructionBindings } from '../../construction/runtime-construction-dependencies'
import { OrcaRuntimeWithGetUnpersistedTrackedTitleForPty } from './terminal-title-tracker'

export abstract class OrcaRuntimeWithChatStopInputObservation extends OrcaRuntimeWithGetUnpersistedTrackedTitleForPty {
  declare protected readonly captureChatStopInputFn:
    | RuntimeConstructionBindings['captureChatStopInput']
    | null
  declare protected readonly clearChatStopInputFn:
    | RuntimeConstructionBindings['clearChatStopInput']
    | null
  protected abstract getPtyLifecycleGeneration(ptyId: string): number
  protected abstract collectPaneKeysForPty(ptyId: string): Set<string>

  captureChatStopInput(ptyId: string, value: unknown): WriteSettlementSink | undefined {
    try {
      const input = parseChatStopInput(value)
      const pty = this.ptysById.get(ptyId)
      const capture = this.captureChatStopInputFn
      if (!input || !pty || pty.connectionId || !capture) {
        return
      }
      const generation = this.getPtyLifecycleGeneration(ptyId)
      const processIncarnation = pty.incarnationId ?? `${this.runtimeId}:${ptyId}:${generation}`
      const sinks = Array.from(this.collectPaneKeysForPty(ptyId), (paneKey) =>
        capture(paneKey, input, {
          ptyId,
          generation,
          processIncarnation,
          isCurrent: () =>
            this.ptysById.get(ptyId) === pty &&
            this.collectPaneKeysForPty(ptyId).has(paneKey) &&
            this.getPtyLifecycleGeneration(ptyId) === generation &&
            (this.ptysById.get(ptyId)?.incarnationId ??
              `${this.runtimeId}:${ptyId}:${generation}`) === processIncarnation
        })
      )
      return (result) => {
        for (const sink of sinks) {
          reportWriteSettlement(sink, result)
        }
      }
    } catch {
      return undefined
    }
  }

  clearChatStopInputs(ptyId?: string): void {
    if (ptyId === undefined) {
      this.clearChatStopInputFn?.()
    } else {
      for (const paneKey of this.collectPaneKeysForPty(ptyId)) {
        this.clearChatStopInputFn?.(paneKey)
      }
    }
  }
}
