import type { retainRelayPtyCommittedSourceCustody } from './relay-pty-committed-source-custody'
import type { prepareRelayPtyCoveredSourceRetirement } from './relay-pty-source-delivery-retirement'
import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { parseRelayPtyCoveredSourceRetirement } from './relay-pty-covered-source-retirement-journal'
import { serializeDurableRecord } from './relay-pty-ownership-transfer-record-serialization'
import { runRelayPtyRetirementWriteTransaction } from './relay-pty-retirement-write-transaction'

type Custody = ReturnType<typeof retainRelayPtyCommittedSourceCustody>
type Cleanup = ReturnType<typeof prepareRelayPtyCoveredSourceRetirement>
const running = new WeakMap<RelayPtyOwnershipTransferAdapterState, Set<string>>()

/** Internal only: cleanup must bind fresh successor authority; persisted custody never grants it. */
export function retireRelayPtyCoveredSourceDelivery(
  state: RelayPtyOwnershipTransferAdapterState,
  custody: Custody,
  retirementRecordSha256: string,
  recoveryOnly: boolean,
  prepareCleanup: (custody: Custody) => Cleanup
) {
  if (
    typeof retirementRecordSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(retirementRecordSha256) ||
    typeof recoveryOnly !== 'boolean'
  ) {
    throw new Error('pty_source_retirement_request_invalid')
  }
  const bridgeId = custody.identity.bridgeId
  let active = running.get(state)
  if (!active) {
    active = new Set()
    running.set(state, active)
  }
  if (active.has(bridgeId)) {
    throw new Error('pty_source_retirement_busy')
  }
  active.add(bridgeId)
  try {
    custody.assertCurrent(state)
    const transfer = state.transfers.get(bridgeId)
    const history = state.histories.get(custody.identity.terminalId)
    if (!state.options.store || !transfer || !history || transfer.sourceDeliveryRetirement) {
      throw new Error('pty_source_retirement_covered_custody_required')
    }
    const historical = transfer.coveredSourceDeliveryRetirement
    if (recoveryOnly && !historical) {
      throw new Error('pty_source_retirement_recovery_journal_required')
    }
    const evidence = parseRelayPtyCoveredSourceRetirement(
      {
        phase: historical?.phase ?? 'prepared',
        retirementRecordSha256,
        modelSha256: custody.modelSha256,
        sourceOutputEndSeq: custody.sourceOutputEndSeq,
        receipt: custody.receipt,
        delivery: custody.delivery
      },
      serializeDurableRecord(transfer, history, state.replayBytes)
    )
    if (historical && JSON.stringify(historical) !== JSON.stringify(evidence)) {
      throw new Error('pty_source_retirement_attempt_changed')
    }
    const cleanup = prepareCleanup(custody)
    if (typeof cleanup.assertRemoved !== 'function') {
      throw new Error('pty_source_retirement_restart_reconstruction_required')
    }
    if (
      JSON.stringify(
        parseRelayPtyCoveredSourceRetirement(
          { ...evidence, delivery: cleanup.delivery },
          serializeDurableRecord(transfer, history, state.replayBytes)
        )
      ) !== JSON.stringify(evidence)
    ) {
      throw new Error('pty_source_retirement_expected_delivery_mismatch')
    }
    const operation = {
      evidence,
      installed: !!historical,
      running: false,
      cleanup,
      assertRemoved: cleanup.assertRemoved.bind(cleanup)
    }
    const assertCurrent = () => {
      custody.assertCurrent(state)
      if (
        state.transfers.get(bridgeId) !== transfer ||
        transfer.sourceDeliveryRetirement ||
        JSON.stringify(transfer.coveredSourceDeliveryRetirement) !==
          JSON.stringify(operation.installed ? operation.evidence : undefined)
      ) {
        throw new Error('pty_source_retirement_evidence_changed')
      }
      cleanup.assertCurrent()
      if (operation.evidence.phase === 'retired') {
        operation.assertRemoved()
      }
    }
    assertCurrent()
    runRelayPtyRetirementWriteTransaction(
      state,
      transfer,
      operation,
      assertCurrent,
      (next) => {
        transfer.coveredSourceDeliveryRetirement = next
      },
      true
    )
    return Object.freeze({
      ...transfer.identity,
      coveredSourceDeliveryRetirement: structuredClone(operation.evidence),
      sourceCancellation: Object.freeze({
        canceled: true as const,
        sentEndSu: operation.evidence.delivery.sentEndSu,
        creditedEndSu: operation.evidence.delivery.creditedEndSu
      })
    })
  } finally {
    active.delete(bridgeId)
  }
}
