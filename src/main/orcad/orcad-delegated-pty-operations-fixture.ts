import { vi } from 'vitest'
import { createOrcadDelegatedPtyOperations } from './orcad-delegated-pty-operations'
import { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import {
  transitionDelegatedInputState,
  type DelegatedInputState
} from '../persistence/pty-ownership-transfer/pty-ownership-transfer-delegated-input-state'
import {
  identity,
  preparation,
  request
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import type { PtyOwnershipTransferDestinationSnapshot } from '../../shared/pty-ownership-transfer-destination-adapter'

export function setupDelegatedPtyOperations(epoch = 0) {
  let inputState: DelegatedInputState = { epoch, retiring: false, entries: [] }
  const claim = { generation: 1, claimId: 'claim' }
  const snapshot: PtyOwnershipTransferDestinationSnapshot = {
    identity,
    phase: 'published',
    sourceOutputEndSeq: 0,
    acceptedSourceEndSeq: 0,
    stagedOutputFrames: 0,
    stagedOutputBytes: 0,
    acceptedInputIds: 0,
    liveOutputEndSeq: 0,
    surfaceBinding: preparation.surfacePublication.surfaceBinding,
    executionVerdict: 'live',
    delegatedClaim: claim,
    delegatedClaimActive: true,
    publicationReceipt: {
      version: 1,
      publicationReceiptId: 'published',
      bridgeId: identity.bridgeId,
      destinationRuntimeId: identity.destinationRuntimeId,
      publishedAt: '2026-09-06T00:00:00Z',
      commitReceipt: {
        bridgeId: identity.bridgeId,
        receiptId: 'receipt',
        acceptedSourceEndSeq: 0,
        committedAt: '2026-09-06T00:00:00Z'
      }
    }
  }
  const transport = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
    ...identity,
    version: 1,
    outcome: 'applied',
    duplicate: false,
    inputId: params.inputId,
    inputEpoch: params.inputEpoch,
    controlId: params.controlId
  }))
  const controller = new AbortController()
  const isActive = vi.fn(() => true)
  const isCommitReconciled = vi.fn(() => true)
  const operations = createOrcadDelegatedPtyOperations({
    inputJournal: {
      loadDelegated: () => structuredClone(inputState),
      transitionDelegated: (_identity, command) => {
        inputState = transitionDelegatedInputState(inputState, command, 100)
        return structuredClone(inputState)
      }
    },
    client: new OrcadDelegatedTransferClient((method, params) =>
      transport(method, params as Record<string, unknown>)
    ),
    adapter: { snapshot: () => snapshot },
    proof: request(),
    claim,
    signal: controller.signal,
    isActive,
    isCommitReconciled
  })
  return {
    operations,
    snapshot,
    transport,
    controller,
    isActive,
    isCommitReconciled,
    readInputs: () => structuredClone(inputState)
  }
}
