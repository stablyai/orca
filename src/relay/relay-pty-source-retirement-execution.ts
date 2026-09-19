import { parsePtyOwnershipTransferSourceRetirementRequest } from '../shared/pty-ownership-transfer-source-retirement'
import type { RequestContext } from './dispatcher'
import type {
  RelayPtyOwnershipTransferAdapterState,
  RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'
import {
  requireDestinationProof,
  isRelayPtyOwnershipTransferDestinationClaimActive
} from './relay-pty-ownership-transfer-destination-claim'
import { runRelayPtyRetirementWriteTransaction } from './relay-pty-retirement-write-transaction'
import {
  parseRelayPtySourceRetirement,
  type RelayPtySourceRetirement
} from './relay-pty-source-retirement-journal'
import type { prepareRelayPtySourceDeliveryRetirement } from './relay-pty-source-delivery-retirement'

type Cleanup = Omit<ReturnType<typeof prepareRelayPtySourceDeliveryRetirement>, 'assertRemoved'> & {
  assertRemoved?: () => void
}
type Attempt = {
  transfer: RelayPtyOwnershipTransferRecord
  receipt: string
  cleanup: Cleanup
  evidence: RelayPtySourceRetirement
  installed: boolean
  running: boolean
  assertRemoved?: () => void
}
const attempts = new WeakMap<RelayPtyOwnershipTransferAdapterState, Map<string, Attempt>>()

/** Historical intent requires fresh exact delivery evidence, never inferred local absence. */
export function retireRelayPtySourceDelivery(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext,
  prepareCleanup: (expectedDelivery?: RelayPtySourceRetirement['delivery']) => Cleanup
) {
  const request = parsePtyOwnershipTransferSourceRetirementRequest(value)
  const hash = request.retirementRecordSha256
  const { transfer } = requireDestinationProof(state, request, context)
  const assertClaim = () => {
    if (transfer.coveredSourceDeliveryRetirement) {
      throw new Error('pty_source_retirement_covered_recovery_required')
    }
    if (
      !state.options.enableDestinationDelegationCommit ||
      transfer.phase !== 'committed' ||
      requireDestinationProof(state, request, context).transfer !== transfer ||
      !isRelayPtyOwnershipTransferDestinationClaimActive(
        state,
        request,
        request.destinationClaim,
        context
      )
    ) {
      throw new Error('pty_source_retirement_destination_claim_required')
    }
  }
  assertClaim()
  if (
    request.recoveryOnly &&
    (!transfer.sourceDeliveryRetirement ||
      transfer.sourceDeliveryRetirement.retirementRecordSha256 !== hash)
  ) {
    throw new Error('pty_source_retirement_recovery_journal_required')
  }
  let byBridge = attempts.get(state)
  if (!byBridge) {
    byBridge = new Map()
    attempts.set(state, byBridge)
  }
  let attempt = byBridge.get(request.bridgeId)
  if (!attempt) {
    const historical = transfer.sourceDeliveryRetirement
    if (historical && historical.retirementRecordSha256 !== hash) {
      throw new Error('pty_source_retirement_attempt_changed')
    }
    const cleanup = prepareCleanup(historical?.delivery)
    assertClaim()
    const assertRemoved = cleanup.assertRemoved?.bind(cleanup)
    if (historical?.phase === 'retired') {
      if (!assertRemoved) {
        throw new Error('pty_source_retirement_restart_reconstruction_required')
      }
      assertRemoved()
    }
    const evidence = parseRelayPtySourceRetirement(
      {
        phase: historical?.phase ?? 'prepared',
        retirementRecordSha256: hash,
        delivery: cleanup.delivery
      },
      transfer
    )
    if (
      request.expectedDelivery &&
      JSON.stringify(request.expectedDelivery) !== JSON.stringify(evidence.delivery)
    ) {
      throw new Error('pty_source_retirement_expected_delivery_mismatch')
    }
    if (historical && JSON.stringify(historical) !== JSON.stringify(evidence)) {
      throw new Error('pty_source_retirement_restart_delivery_mismatch')
    }
    attempt = {
      transfer,
      receipt: JSON.stringify(transfer.commitReceipt),
      cleanup,
      evidence,
      installed: !!historical,
      running: false,
      assertRemoved
    }
    byBridge.set(request.bridgeId, attempt)
  }
  const operation = attempt
  if (request.recoveryOnly && !operation.assertRemoved) {
    throw new Error('pty_source_retirement_restart_reconstruction_required')
  }
  if (operation.running) {
    throw new Error('pty_source_retirement_busy')
  }
  if (operation.transfer !== transfer || operation.evidence.retirementRecordSha256 !== hash) {
    throw new Error('pty_source_retirement_attempt_changed')
  }
  const assertCurrent = () => {
    assertClaim()
    if (
      request.expectedDelivery &&
      JSON.stringify(request.expectedDelivery) !== JSON.stringify(operation.evidence.delivery)
    ) {
      throw new Error('pty_source_retirement_expected_delivery_mismatch')
    }
    if (
      JSON.stringify(transfer.commitReceipt) !== operation.receipt ||
      JSON.stringify(transfer.sourceDeliveryRetirement) !==
        JSON.stringify(operation.installed ? operation.evidence : undefined)
    ) {
      throw new Error('pty_source_retirement_evidence_changed')
    }
    operation.cleanup.assertCurrent()
    if (operation.evidence.phase === 'retired') {
      operation.assertRemoved?.()
    }
  }
  runRelayPtyRetirementWriteTransaction(
    state,
    transfer,
    operation,
    assertCurrent,
    (evidence) => {
      transfer.sourceDeliveryRetirement = evidence
    },
    request.recoveryOnly === true
  )
  return Object.freeze({
    ...transfer.identity,
    version: 1 as const,
    ...(request.recoveryOnly
      ? {
          sourceCancellation: Object.freeze({
            canceled: true as const,
            sentEndSu: operation.evidence.delivery.sentEndSu,
            creditedEndSu: operation.evidence.delivery.creditedEndSu
          })
        }
      : {}),
    sourceDeliveryRetirement: structuredClone(operation.evidence)
  })
}
