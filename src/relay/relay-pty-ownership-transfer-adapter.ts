import { registerRelayPtyOwnershipTransferRequests } from './relay-pty-ownership-transfer-request-registration'
import type { RelayPtyRawEmissionSlice } from './relay-pty-raw-emission-checkpoint'
import { supportsRelayPtySourceRetirement } from './relay-pty-source-retirement-capability'
import { supportsRelayPtySuccessorRetirement } from './relay-pty-successor-retirement-registration'
import { relayPtyRequestAttachmentBinding } from './relay-pty-ownership-transfer-adapter-attachment'
import {
  inspectRelayPtyOwnershipCaptureCursor,
  inspectRelayPtyOwnershipSuccessorCaptureEvidence
} from './relay-pty-ownership-transfer-capture-cursor'
import { selectRelayPtyOwnershipCaptureBaseline } from './relay-pty-ownership-transfer-capture-selection'
import { retainRelayPtyOwnershipCaptureBoundary } from './relay-pty-ownership-issued-capture-boundary'
import { assertRelayPtyOwnershipTransferSourceRoute } from './relay-pty-ownership-transfer-source-route-authorization'
import {
  claimRelayPtyOwnershipTransferDestination,
  inspectRelayPtyOwnershipTransferDestination,
  recoverRelayPtyOwnershipTransferDestination,
  isRelayPtyOwnershipTransferDestinationClaimActive
} from './relay-pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferDestinationClaim } from '../shared/pty-ownership-transfer-destination-claim'
import {
  PTY_OWNERSHIP_TRANSFER_METHODS,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
} from '../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  acceptRelayPtyOwnershipTransferInput,
  abortRelayPtyOwnershipTransfer,
  retireRelayPtyOwnershipTransferInput,
  statusRelayPtyOwnershipTransfer,
  snapshotRelayPtyOwnershipTransfer,
  type RelayPtyOwnershipTransferSnapshot
} from './relay-pty-ownership-transfer-adapter-input'
import {
  commitRelayPtyOwnershipTransfer,
  prepareRelayPtyOwnershipTransfer,
  publishRelayPtyOwnershipTransfer,
  replayRelayPtyOwnershipTransfer
} from './relay-pty-ownership-transfer-adapter-operations'
import type { RelayPtyOwnershipTransferAdapterOptions } from './relay-pty-ownership-transfer-adapter-contract'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import {
  newRelayPtyOwnershipTransferAdapterState,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'
import { isRelayPtyOwnershipTransferDestinationAttachmentActive } from './relay-pty-ownership-transfer-adapter-attachment'
import { removeRelayPtyOwnershipTerminal } from './relay-pty-ownership-terminal-removal'
import { recoverRelayPtyOwnershipCaptureSelection } from './relay-pty-ownership-capture-selection-recovery'
import {
  attachRelayPtyOwnershipTransferDestination,
  controlRelayPtyOwnershipTransferDestination
} from './relay-pty-ownership-transfer-control'
import { observeRelayPtyOwnershipTransferAdapterExit } from './relay-pty-ownership-transfer-adapter-exit'
import { observeRelayPtyOwnershipTransferOutput } from './relay-pty-ownership-transfer-output-observation'
import { restoreRelayPtyOwnershipTransferInputFences } from './relay-pty-ownership-transfer-input-fence-recovery'
import { rekeyRelayPtyOwnershipTransferReconnect } from './relay-pty-ownership-transfer-reconnect-rekey'
import {
  canRecoverRelayPtyOwnershipTransferPreparedAbort,
  canRecoverRelayPtyOwnershipTransferReconnectRekey,
  canRecoverRelayPtyOwnershipTransferStatus,
  recoverRelayPtyOwnershipTransferPostCommitRouteGeneration
} from './relay-pty-ownership-transfer-recovery-authorization'

export type {
  RelayPtyOwnershipTransferAdapterOptions,
  RelayPtyOwnershipTransferSource
} from './relay-pty-ownership-transfer-adapter-contract'
export { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
export type { RelayPtyOwnershipTransferSnapshot } from './relay-pty-ownership-transfer-adapter-input'

/** Relay-side source adapter; mutating registration remains dormant on mixed-version peers. */
export class RelayPtyOwnershipTransferAdapter {
  private readonly state: RelayPtyOwnershipTransferAdapterState

  supportsSourceDeliveryRetirement(): boolean {
    return supportsRelayPtySourceRetirement(this.state.options)
  }
  supportsSuccessorSourceRetirement(): boolean {
    return supportsRelayPtySuccessorRetirement(this.state.options)
  }

  recoverCaptureSelection(proof: unknown, baseline: unknown, context: RequestContext) {
    return recoverRelayPtyOwnershipCaptureSelection(this.state, proof, baseline, context)
  }

  retainCaptureBoundary(
    identity: PtyOwnershipTransferWireIdentity,
    boundary: Parameters<typeof retainRelayPtyOwnershipCaptureBoundary>[2],
    rawCursor?: number
  ) {
    return retainRelayPtyOwnershipCaptureBoundary(this.state, identity, boundary, rawCursor)
  }

  selectCaptureBaseline(
    identity: PtyOwnershipTransferWireIdentity,
    value: unknown,
    inspectCapture: Parameters<typeof selectRelayPtyOwnershipCaptureBaseline>[3]
  ) {
    return selectRelayPtyOwnershipCaptureBaseline(this.state, identity, value, inspectCapture)
  }

  constructor(options: RelayPtyOwnershipTransferAdapterOptions) {
    this.state = newRelayPtyOwnershipTransferAdapterState({ options })
  }

  /** Register additive RPC methods. Capability advertisement stays with the caller. */
  register(dispatcher: RelayDispatcher): void {
    registerRelayPtyOwnershipTransferRequests(
      dispatcher,
      this,
      this.state,
      this.authorize.bind(this)
    )
  }

  claimDestination(value: unknown, context: RequestContext) {
    return claimRelayPtyOwnershipTransferDestination(this.state, value, context)
  }

  inspectDestination(value: unknown, context: RequestContext) {
    return inspectRelayPtyOwnershipTransferDestination(this.state, value, context)
  }

  recoverDestination(value: unknown, context: RequestContext) {
    return recoverRelayPtyOwnershipTransferDestination(this.state, value, context)
  }

  isDestinationClaimActive(
    identity: PtyOwnershipTransferWireIdentity,
    claim: PtyOwnershipTransferDestinationClaim,
    context: RequestContext
  ): boolean {
    return isRelayPtyOwnershipTransferDestinationClaimActive(this.state, identity, claim, context)
  }

  /** Register only the read-only recovery probe while live transfer remains disabled. */
  registerStatus(dispatcher: RelayDispatcher): void {
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.status, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.status, params, context)
      return this.status(params)
    })
  }

  /** Allows only the exact prepared identity to use resumed-owner abort authorization. */
  canRecoverPreparedAbort(value: unknown): boolean {
    return canRecoverRelayPtyOwnershipTransferPreparedAbort(this.state, value)
  }

  /** Allows a resumed owner to inspect only the exact durable transfer it already owned. */
  canRecoverStatus(value: unknown): boolean {
    return canRecoverRelayPtyOwnershipTransferStatus(this.state, value)
  }

  /** Allows only attachment-fenced recovery routes for an exact committed transfer. */
  canRecoverPostCommitRoute(value: unknown): boolean {
    return this.recoverPostCommitRouteGeneration(value) !== null
  }

  /** Returns the exact durable generation only when the request names its active route. */
  recoverPostCommitRouteGeneration(value: unknown): number | null {
    return recoverRelayPtyOwnershipTransferPostCommitRouteGeneration(this.state, value)
  }

  /** Allows a resumed owner to advance only the exact durable route it already owns. */
  canRecoverReconnectRekey(value: unknown): boolean {
    return canRecoverRelayPtyOwnershipTransferReconnectRekey(this.state, value)
  }

  /** Feed raw PTY output before the normal source-credit publication path. */
  getPreparedOutputByteLimit(terminalId: string): number | undefined {
    const bridgeId = this.state.transferByTerminal.get(terminalId)
    const transfer = bridgeId ? this.state.transfers.get(bridgeId) : undefined
    return transfer?.destinationOutputRetention &&
      (transfer.phase === 'prepared' || transfer.phase === 'committed')
      ? this.state.replayBytes
      : undefined
  }

  inspectPreparedCaptureCursor(identity: PtyOwnershipTransferWireIdentity): number | null {
    return inspectRelayPtyOwnershipCaptureCursor(this.state, identity)
  }

  inspectSuccessorCaptureEvidence(identity: PtyOwnershipTransferWireIdentity, baseline: unknown) {
    return inspectRelayPtyOwnershipSuccessorCaptureEvidence(this.state, identity, baseline)
  }

  ownsOutputPublication(terminalId: string): boolean {
    const bridgeId = this.state.transferByTerminal.get(terminalId)
    const transfer = bridgeId ? this.state.transfers.get(bridgeId) : undefined
    return !!transfer?.destinationDelegation && transfer.phase === 'committed'
  }

  fencesLegacyAttachment(terminalId: string): boolean {
    const bridgeId = this.state.transferByTerminal.get(terminalId)
    const transfer = bridgeId ? this.state.transfers.get(bridgeId) : undefined
    return (
      !!transfer?.destinationDelegation &&
      (transfer.phase === 'prepared' || transfer.phase === 'committed')
    )
  }

  observeOutput(
    terminalId: string,
    data: string,
    emissionKey?: string,
    admittedIncarnationId?: string,
    ingressSlice?: RelayPtyRawEmissionSlice
  ): ReturnType<typeof observeRelayPtyOwnershipTransferOutput> {
    return observeRelayPtyOwnershipTransferOutput(
      this.state,
      terminalId,
      data,
      emissionKey,
      admittedIncarnationId,
      ingressSlice
    )
  }

  restoreInputFences(): number {
    return restoreRelayPtyOwnershipTransferInputFences(this.state)
  }

  /** Drop source history and close any transient bridge record when a PTY exits. */
  removeTerminal(terminalId: string, incarnationId?: string): void {
    removeRelayPtyOwnershipTerminal(this.state, terminalId, incarnationId)
  }

  prepare(value: unknown) {
    return prepareRelayPtyOwnershipTransfer(this.state, value)
  }

  replay(value: unknown, context?: RequestContext) {
    return replayRelayPtyOwnershipTransfer(
      this.state,
      value,
      relayPtyRequestAttachmentBinding(context)
    )
  }

  commit(value: unknown) {
    return commitRelayPtyOwnershipTransfer(this.state, value)
  }

  publish(value: unknown) {
    return publishRelayPtyOwnershipTransfer(this.state, value)
  }

  status(value: unknown) {
    return statusRelayPtyOwnershipTransfer(this.state, value)
  }

  acceptInput(value: unknown) {
    return acceptRelayPtyOwnershipTransferInput(this.state, value)
  }

  retireInput(value: unknown) {
    return retireRelayPtyOwnershipTransferInput(this.state, value)
  }

  attach(value: unknown, context?: RequestContext) {
    return attachRelayPtyOwnershipTransferDestination(
      this.state,
      value,
      relayPtyRequestAttachmentBinding(context)
    )
  }

  rekeyReconnect(value: unknown, context?: RequestContext) {
    return rekeyRelayPtyOwnershipTransferReconnect(
      this.state,
      value,
      relayPtyRequestAttachmentBinding(context)
    )
  }

  control(value: unknown, context?: RequestContext) {
    return controlRelayPtyOwnershipTransferDestination(
      this.state,
      value,
      relayPtyRequestAttachmentBinding(context)
    )
  }

  /** Return true only while the exact attachment and authenticated route are live. */
  isDestinationAttachmentActive(
    value: PtyOwnershipTransferWireIdentity & { attachmentId: string },
    context?: RequestContext
  ): boolean {
    return isRelayPtyOwnershipTransferDestinationAttachmentActive(this.state, value, context)
  }

  observeExit(
    terminalOrEvent: string | { terminalId: string; incarnationId: string; code?: number },
    incarnationId?: string,
    code?: number
  ): void {
    observeRelayPtyOwnershipTransferAdapterExit(this.state, terminalOrEvent, incarnationId, code)
  }

  abort(value: unknown) {
    return abortRelayPtyOwnershipTransfer(this.state, value)
  }

  snapshot(bridgeId: string): RelayPtyOwnershipTransferSnapshot | null {
    return snapshotRelayPtyOwnershipTransfer(this.state, bridgeId)
  }

  private async authorize(
    method: string,
    params: Record<string, unknown>,
    context: RequestContext
  ): Promise<void> {
    if (!(await this.state.options.authorizeRequest(method, params, context))) {
      throw new RelayPtyOwnershipTransferError(
        'identity-mismatch',
        'ownership transfer request is not authorized for this relay owner'
      )
    }
    if (context.isStale()) {
      throw new RelayPtyOwnershipTransferError(
        'stale-request',
        'ownership transfer request became stale before relay mutation'
      )
    }
    assertRelayPtyOwnershipTransferSourceRoute(this.state, method, params)
  }
}

export type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
export { PTY_OWNERSHIP_TRANSFER_WIRE_VERSION }
