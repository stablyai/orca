import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import { isStatuslessIdleProofCurrent } from './mailbox-statusless-idle-proof'
import type { OrchestrationStatuslessIdleProof } from './mailbox-pointer-state'

type StatuslessCodexProofDependencies = {
  getLeaf: (leafKey: string) => OrchestrationMailboxLeaf | undefined
  getLeafKey: (tabId: string, leafId: string) => string
  getTerminalProcessIncarnation: (terminalHandle: string) => string | null
  proveStatuslessCodexIdle?: (terminalHandle: string, ptyId: string) => Promise<string | null>
}

export class OrchestrationMailboxStatuslessCodexProofCoordinator {
  private readonly proofsByPtyId = new Map<string, Promise<string | null>>()

  constructor(private readonly deps: StatuslessCodexProofDependencies) {}

  retirePty(ptyId: string): void {
    this.proofsByPtyId.delete(ptyId)
  }

  runWhenProven(
    terminalHandle: string,
    leaf: OrchestrationMailboxLeaf,
    onProven: (
      currentLeaf: OrchestrationMailboxLeaf,
      proof: OrchestrationStatuslessIdleProof
    ) => void
  ): void {
    const prove = this.deps.proveStatuslessCodexIdle
    const ptyId = leaf.ptyId
    if (!prove || !ptyId) {
      return
    }
    let proofPromise = this.proofsByPtyId.get(ptyId)
    if (!proofPromise) {
      try {
        proofPromise = prove(terminalHandle, ptyId).catch(() => null)
      } catch {
        return
      }
      this.proofsByPtyId.set(ptyId, proofPromise)
      void proofPromise.finally(() => {
        if (this.proofsByPtyId.get(ptyId) === proofPromise) {
          this.proofsByPtyId.delete(ptyId)
        }
      })
    }
    void proofPromise
      .then((processIncarnation) => {
        if (!processIncarnation) {
          return
        }
        const currentLeaf = this.deps.getLeaf(this.deps.getLeafKey(leaf.tabId, leaf.leafId))
        const proof = { ptyId, terminalHandle, processIncarnation }
        if (
          currentLeaf?.writable &&
          isStatuslessIdleProofCurrent(currentLeaf, proof, this.deps.getTerminalProcessIncarnation)
        ) {
          onProven(currentLeaf, proof)
        }
      })
      .catch(() => undefined)
  }
}
