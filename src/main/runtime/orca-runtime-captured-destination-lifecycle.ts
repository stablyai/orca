import { OrcaRuntimeWithDelegatedTerminalExit } from './orca-runtime-delegated-terminal-exit'
import type { RuntimeCapturedPtyDestinationLifecycle } from './runtime-ownership-transfer-contracts'
import { inspectRuntimeCapturedDestinationActivation } from './captured-destination-activation'
import { inspectRuntimeCapturedDestinationOutputCoverage } from './captured-destination-output-coverage'
import { retireRuntimeCapturedSourceDelivery } from './captured-source-retirement'
import { prepareRuntimeCapturedDestination } from './captured-destination-preparation'
import type { RuntimeCapturedSourceRetirementRequest } from './runtime-ownership-transfer-contracts'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'

export class OrcaRuntimeWithCapturedDestinationLifecycle extends OrcaRuntimeWithDelegatedTerminalExit {
  private capturedDestinationLifecycle: {
    lifecycle: RuntimeCapturedPtyDestinationLifecycle
  } | null = null

  installCapturedPtyDestinationLifecycle(
    lifecycle: RuntimeCapturedPtyDestinationLifecycle
  ): () => void {
    if (this.capturedDestinationLifecycle) {
      throw new Error('pty_ownership_transfer_captured_lifecycle_already_installed')
    }
    const registration = { lifecycle }
    this.capturedDestinationLifecycle = registration
    return () => {
      if (this.capturedDestinationLifecycle === registration) {
        this.capturedDestinationLifecycle = null
      }
    }
  }

  async prepareCapturedPtyDestination(
    request: Parameters<RuntimeCapturedPtyDestinationLifecycle['prepareCapturedDestination']>[0]
  ) {
    return prepareRuntimeCapturedDestination({
      request,
      runtimeId: this.runtimeId,
      mutationEnabled: () => this.ptyOwnershipTransferMutationEnabled(),
      getLifecycle: () => this.capturedDestinationLifecycle?.lifecycle
    })
  }

  async inspectCapturedPtyDestinationActivation(
    value: PtyOwnershipTransferWireIdentity,
    signal: AbortSignal
  ) {
    return inspectRuntimeCapturedDestinationActivation({
      identity: value,
      signal,
      runtimeId: this.runtimeId,
      getLifecycle: () => this.capturedDestinationLifecycle?.lifecycle,
      supportsPublication: () => this.supportsCapturedCatalogPublication()
    })
  }

  supportsCapturedCatalogActivation(): boolean {
    return (
      this.supportsCapturedCatalogPublication() &&
      typeof this.capturedDestinationLifecycle?.lifecycle.inspectPublishedDestinationActivation ===
        'function'
    )
  }

  inspectCapturedPtyDestinationOutputCoverage(
    identity: PtyOwnershipTransferWireIdentity,
    throughSeq: number,
    signal: AbortSignal
  ) {
    return inspectRuntimeCapturedDestinationOutputCoverage({
      identity,
      throughSeq,
      signal,
      runtimeId: this.runtimeId,
      getLifecycle: () => this.capturedDestinationLifecycle?.lifecycle,
      supportsPublication: () => this.supportsCapturedCatalogPublication()
    })
  }

  supportsCapturedCatalogOutputCoverage(): boolean {
    return (
      this.supportsCapturedCatalogPublication() &&
      typeof this.capturedDestinationLifecycle?.lifecycle
        .inspectPublishedDestinationOutputCoverage === 'function'
    )
  }

  retireCapturedSourceDelivery(request: RuntimeCapturedSourceRetirementRequest) {
    return retireRuntimeCapturedSourceDelivery({
      request,
      runtimeId: this.runtimeId,
      getLifecycle: () => this.capturedDestinationLifecycle?.lifecycle,
      supportsPublication: () => this.supportsCapturedCatalogPublication()
    })
  }

  supportsCapturedCatalogPublication(): boolean {
    return (
      this.ptyOwnershipTransferMutationEnabled() &&
      this.capturedDestinationLifecycle?.lifecycle.supportsCapturedCatalogPublication?.() === true
    )
  }

  supportsCapturedSourceRetirement(): boolean {
    return (
      this.supportsCapturedCatalogActivation() &&
      typeof this.capturedDestinationLifecycle?.lifecycle.retirePublishedSourceDelivery ===
        'function'
    )
  }

  supportsCapturedSourceRetirementRecovery(): boolean {
    return (
      this.supportsCapturedSourceRetirement() &&
      this.capturedDestinationLifecycle?.lifecycle.supportsCapturedSourceRetirementRecovery?.() ===
        true
    )
  }
}
