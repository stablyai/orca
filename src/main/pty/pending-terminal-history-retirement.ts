import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { PtyFencedTerminationRequest } from '../../shared/terminal/pty/lifecycle/pty-fenced-termination'

export const pendingTerminalHistoryRetirement = Symbol('pendingTerminalHistoryRetirement')
export type PendingTerminalHistoryRetirement = {
  id: string
  incarnationId: string
  completion: Promise<void>
  exited: boolean
  hold: () => () => void
  removeHistory: () => void
  finish: (detach: boolean) => Promise<void>
}
type RetirementProvider = IPtyProvider & {
  [pendingTerminalHistoryRetirement]?: (
    request: PtyFencedTerminationRequest
  ) => PendingTerminalHistoryRetirement | undefined
}

/** Composition retains only already admitted retirement work, never an absent-ID route. */
export class PendingTerminalHistoryRetirements {
  private readonly pending = new Set<PendingTerminalHistoryRetirement>()
  capture(provider: IPtyProvider, request: PtyFencedTerminationRequest): void {
    const retirementProvider: RetirementProvider = provider
    const receipt = retirementProvider[pendingTerminalHistoryRetirement]?.(request)
    if (!receipt || this.pending.has(receipt)) {
      return
    }
    this.pending.add(receipt)
    void receipt.completion.then(() => this.pending.delete(receipt))
  }
  find(request: PtyFencedTerminationRequest): PendingTerminalHistoryRetirement | undefined {
    return [...this.pending].find(
      (receipt) =>
        receipt.id === request.id && receipt.incarnationId === request.expectedIncarnationId
    )
  }
}
