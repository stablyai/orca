import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_CWD_METHOD,
  parsePtyOwnershipTransferDestinationCwdRequest,
  parsePtyOwnershipTransferDestinationCwdResult
} from '../../shared/pty-ownership-transfer-destination-cwd'
import { recoverOrcadSourceCaptureSelection } from './orcad-capture-selection-recovery-client'
import { retireOrcadSourceDelivery } from './orcad-delegated-source-retirement-client'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_PROCESS_METHOD,
  parsePtyOwnershipTransferDestinationProcessResult
} from '../../shared/pty-ownership-transfer-destination-process'
import {
  PTY_OWNERSHIP_CAPTURE_IMPORT_ACK_METHOD,
  parsePtyOwnershipCaptureImportAcknowledgement,
  parsePtyOwnershipCaptureImportAcknowledgementResult
} from '../../shared/pty-ownership-capture-import-receipt'
import {
  parsePtyOwnershipTransferDestinationProof,
  parsePtyOwnershipTransferDestinationInspectionRequest,
  parsePtyOwnershipTransferDestinationClaimRequest,
  parsePtyOwnershipTransferDestinationCommitRequest,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_RECOVER_METHOD
} from '../../shared/pty-ownership-transfer-destination-claim'
import {
  parsePtyOwnershipTransferDestinationClaimResult,
  parsePtyOwnershipTransferDestinationStatus
} from '../../shared/pty-ownership-transfer-destination-status'
import { parsePtyOwnershipTransferCommitResult } from '../../shared/pty-ownership-transfer-wire-results'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { samePtyOwnershipTransferCommitReceipt } from '../../shared/pty-ownership-transfer-receipt-validation'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferDestinationInputRequest,
  parsePtyOwnershipTransferDestinationRetireInputRequest,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_RETIRE_INPUT_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD
} from '../../shared/pty-ownership-transfer-destination-input'
import {
  parsePtyOwnershipTransferDestinationControlRequest,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD
} from '../../shared/pty-ownership-transfer-destination-control'
import { parsePtyOwnershipTransferDestinationOperationResult } from '../../shared/pty-ownership-transfer-destination-operation-result'
import type {
  PtyOwnershipTransferRequestOptions,
  PtyOwnershipTransferRequestTransport
} from '../providers/ssh-pty-ownership-transfer-client'

/** Host-local delegated recovery never borrows the desktop attachment or advances claims implicitly. */
export class OrcadDelegatedTransferClient {
  constructor(private readonly transport: PtyOwnershipTransferRequestTransport) {}

  retireSourceDelivery(
    value: unknown,
    expectedDelivery: unknown,
    options?: PtyOwnershipTransferRequestOptions,
    assertAuthority?: () => void
  ) {
    return retireOrcadSourceDelivery(
      this.transport,
      value,
      expectedDelivery,
      options,
      assertAuthority
    )
  }

  recoverCaptureSelection(
    proof: unknown,
    baseline: unknown,
    options?: PtyOwnershipTransferRequestOptions
  ) {
    return recoverOrcadSourceCaptureSelection(this.transport, proof, baseline, options)
  }

  async acknowledgeInitialModel(value: unknown, options?: PtyOwnershipTransferRequestOptions) {
    const request = parsePtyOwnershipCaptureImportAcknowledgement(value)
    const result = await this.request(
      PTY_OWNERSHIP_CAPTURE_IMPORT_ACK_METHOD,
      request,
      parsePtyOwnershipCaptureImportAcknowledgementResult,
      options
    )
    if (JSON.stringify(result.receipt) !== JSON.stringify(request.receipt)) {
      throw new Error('pty_ownership_capture_import_ack_receipt_mismatch')
    }
    return result
  }

  async inspectProcess(value: unknown, options?: PtyOwnershipTransferRequestOptions) {
    const request = parsePtyOwnershipTransferDestinationInspectionRequest(value)
    const result = await this.request(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_PROCESS_METHOD,
      request,
      parsePtyOwnershipTransferDestinationProcessResult,
      options
    )
    if (
      result.destinationClaim.generation !== request.destinationClaim.generation ||
      result.destinationClaim.claimId !== request.destinationClaim.claimId
    ) {
      throw new Error('pty_ownership_transfer_destination_process_claim_mismatch')
    }
    return result
  }

  async inspectCwd(value: unknown, options?: PtyOwnershipTransferRequestOptions) {
    const request = parsePtyOwnershipTransferDestinationCwdRequest(value)
    const result = await this.request(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_CWD_METHOD,
      request,
      parsePtyOwnershipTransferDestinationCwdResult,
      options
    )
    if (
      result.destinationClaim.generation !== request.destinationClaim.generation ||
      result.destinationClaim.claimId !== request.destinationClaim.claimId
    ) {
      throw new Error('pty_ownership_transfer_destination_cwd_claim_mismatch')
    }
    return result.cwd
  }

  async retireInput(value: unknown, options?: PtyOwnershipTransferRequestOptions) {
    const request = parsePtyOwnershipTransferDestinationRetireInputRequest(value)
    if (request.inputIds.length === 0) {
      throw new Error('pty_ownership_transfer_destination_retire_input_empty')
    }
    return this.request(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_RETIRE_INPUT_METHOD,
      request,
      (value) => {
        const identity = parsePtyOwnershipTransferWireIdentity(value)
        const record = value as Record<string, unknown>
        if (
          record.version !== 1 ||
          record.inputEpoch !== request.inputEpoch + 1 ||
          record.retired !== request.inputIds.length
        ) {
          throw new Error('pty_ownership_transfer_destination_retire_input_response_mismatch')
        }
        return Object.freeze({
          ...identity,
          version: 1 as const,
          inputEpoch: request.inputEpoch + 1,
          retired: request.inputIds.length
        })
      },
      options
    )
  }

  async input(value: unknown, options?: PtyOwnershipTransferRequestOptions) {
    const request = parsePtyOwnershipTransferDestinationInputRequest(value)
    return this.request(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD,
      request,
      (value) => {
        const result = parsePtyOwnershipTransferDestinationOperationResult(value)
        const record = value as Record<string, unknown>
        if (
          record.inputId !== request.inputId ||
          (record.inputEpoch === undefined ? 0 : record.inputEpoch) !== request.inputEpoch
        ) {
          throw new Error('pty_ownership_transfer_destination_input_response_mismatch')
        }
        return Object.freeze({
          ...result,
          inputId: request.inputId,
          inputEpoch: request.inputEpoch
        })
      },
      options
    )
  }

  async control(value: unknown, options?: PtyOwnershipTransferRequestOptions) {
    const request = parsePtyOwnershipTransferDestinationControlRequest(value)
    return this.request(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD,
      request,
      (value) => {
        const result = parsePtyOwnershipTransferDestinationOperationResult(value)
        if ((value as Record<string, unknown>).controlId !== request.controlId) {
          throw new Error('pty_ownership_transfer_destination_control_response_mismatch')
        }
        return Object.freeze({ ...result, controlId: request.controlId })
      },
      options
    )
  }

  async status(value: unknown, options?: PtyOwnershipTransferRequestOptions) {
    const request = parsePtyOwnershipTransferDestinationProof(value)
    return this.request(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD,
      request,
      parsePtyOwnershipTransferDestinationStatus,
      options
    )
  }

  async recover(value: unknown, options?: PtyOwnershipTransferRequestOptions) {
    const request = parsePtyOwnershipTransferDestinationProof(value)
    return this.request(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_RECOVER_METHOD,
      request,
      parsePtyOwnershipTransferDestinationStatus,
      options
    )
  }

  async claim(value: unknown, options?: PtyOwnershipTransferRequestOptions) {
    const request = parsePtyOwnershipTransferDestinationClaimRequest(value)
    const result = await this.request(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD,
      request,
      parsePtyOwnershipTransferDestinationClaimResult,
      options
    )
    if (
      result.destinationGeneration !== request.destinationGeneration ||
      result.claimId !== request.claimId
    ) {
      throw new Error('pty_ownership_transfer_destination_claim_response_mismatch')
    }
    return result
  }

  async commit(value: unknown, options?: PtyOwnershipTransferRequestOptions) {
    const request = parsePtyOwnershipTransferDestinationCommitRequest(value)
    const result = await this.request(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD,
      request,
      parsePtyOwnershipTransferCommitResult,
      options
    )
    if (!samePtyOwnershipTransferCommitReceipt(result.receipt, request.receipt)) {
      throw new Error('pty_ownership_transfer_destination_commit_response_mismatch')
    }
    return result
  }

  private async request<T extends PtyOwnershipTransferWireIdentity>(
    method: string,
    request: PtyOwnershipTransferWireIdentity,
    parse: (value: unknown) => T,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<T> {
    const result = parse(await this.transport(method, request, options))
    if (!samePtyOwnershipTransferIdentity(result, request)) {
      throw new Error('pty_ownership_transfer_destination_response_identity_mismatch')
    }
    return result
  }
}
