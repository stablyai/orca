import type { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import type { PtyOwnershipTransferDestinationAdapter } from '../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferControl } from '../../shared/pty-ownership-transfer-control-wire'
import {
  parsePtyOwnershipTransferDestinationProof,
  parsePtyOwnershipTransferDestinationClaim
} from '../../shared/pty-ownership-transfer-destination-claim'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { samePtyOwnershipTransferCommitReceipt } from '../../shared/pty-ownership-transfer-receipt-validation'
import type { PtyOwnershipTransferDestinationInputFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-input-file-store'

export function createOrcadDelegatedPtyOperations(options: {
  client: Pick<
    OrcadDelegatedTransferClient,
    'input' | 'control' | 'retireInput' | 'status' | 'inspectCwd' | 'inspectProcess'
  >
  adapter: Pick<PtyOwnershipTransferDestinationAdapter, 'snapshot'>
  inputJournal: Pick<
    PtyOwnershipTransferDestinationInputFileStore,
    'loadDelegated' | 'transitionDelegated'
  >
  proof: unknown
  claim: unknown
  signal: AbortSignal
  isActive: () => boolean
  isCommitReconciled: () => boolean
}) {
  const proof = parsePtyOwnershipTransferDestinationProof(options.proof)
  const claim = parsePtyOwnershipTransferDestinationClaim(options.claim)
  const assertAuthority = () => {
    options.signal.throwIfAborted()
    const snapshot = options.adapter.snapshot()
    if (
      !options.isActive() ||
      !options.isCommitReconciled() ||
      !samePtyOwnershipTransferIdentity(snapshot.identity, proof) ||
      snapshot.phase !== 'published' ||
      !snapshot.publicationReceipt ||
      snapshot.surfaceBinding?.executionHostId !== 'local' ||
      snapshot.surfaceBinding.ptyId !== proof.terminalId ||
      !snapshot.delegatedClaimActive ||
      snapshot.delegatedClaim?.generation !== claim.generation ||
      snapshot.delegatedClaim.claimId !== claim.claimId
    ) {
      throw new Error('orcad_delegated_pty_authority_unverifiable')
    }
    return JSON.stringify({
      receipt: snapshot.publicationReceipt,
      binding: snapshot.surfaceBinding
    })
  }
  let tail: Promise<void> = Promise.resolve()
  const perform = async <T>(
    ptyId: string,
    operation: (
      assertCurrent: () => void,
      requestOptions: { signal: AbortSignal; timeoutMs?: number }
    ) => Promise<T>,
    timeoutMs?: number
  ): Promise<T> => {
    if (ptyId !== proof.terminalId) {
      throw new Error('orcad_delegated_pty_identity_mismatch')
    }
    const before = assertAuthority()
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
    const assertCurrent = () => {
      if (deadline !== undefined && (!Number.isFinite(deadline) || Date.now() >= deadline)) {
        throw new Error('orcad_delegated_inspection_deadline_expired')
      }
      if (assertAuthority() !== before) {
        throw new Error('orcad_delegated_pty_authority_superseded')
      }
    }
    const pending = tail.then(async () => {
      assertCurrent()
      const result = await operation(assertCurrent, {
        signal: options.signal,
        ...(deadline === undefined ? {} : { timeoutMs: deadline - Date.now() })
      })
      assertCurrent()
      return result
    })
    tail = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }
  return {
    inspectProcess: (ptyId: string, timeoutMs?: number) =>
      perform(
        ptyId,
        async (_assertCurrent, requestOptions) =>
          options.client.inspectProcess({ ...proof, destinationClaim: claim }, requestOptions),
        timeoutMs
      ),
    inspectCwd: (ptyId: string, timeoutMs?: number) =>
      perform(
        ptyId,
        async (_assertCurrent, requestOptions) =>
          options.client.inspectCwd({ ...proof, destinationClaim: claim }, requestOptions),
        timeoutMs
      ),
    inspectTerminalInfo: (ptyId: string, timeoutMs?: number) =>
      perform(
        ptyId,
        async (assertCurrent, requestOptions) => {
          const status = await options.client.status(proof, requestOptions)
          assertCurrent()
          if (
            !status.boundToConnection ||
            status.destinationClaim?.generation !== claim.generation ||
            status.destinationClaim.claimId !== claim.claimId ||
            !status.receipt ||
            !samePtyOwnershipTransferCommitReceipt(
              status.receipt,
              options.adapter.snapshot().publicationReceipt!.commitReceipt
            )
          ) {
            throw new Error('orcad_delegated_terminal_inspection_unverifiable')
          }
          return status.terminalInfo ?? null
        },
        timeoutMs
      ),
    recoverInputRetirement: (ptyId: string) =>
      perform(ptyId, async (assertCurrent) => {
        const state = options.inputJournal.loadDelegated(proof)
        if (!state?.retiring) {
          return null
        }
        const status = await options.client.status(proof, { signal: options.signal })
        assertCurrent()
        const receipt = options.adapter.snapshot().publicationReceipt!.commitReceipt
        if (
          !samePtyOwnershipTransferIdentity(status, proof) ||
          !status.boundToConnection ||
          status.phase !== 'committed' ||
          !status.receipt ||
          !samePtyOwnershipTransferCommitReceipt(status.receipt, receipt) ||
          status.destinationClaim?.generation !== claim.generation ||
          status.destinationClaim.claimId !== claim.claimId ||
          (status.inputEpoch !== state.epoch && status.inputEpoch !== state.epoch + 1) ||
          JSON.stringify(options.inputJournal.loadDelegated(proof)) !== JSON.stringify(state)
        ) {
          throw new Error('orcad_delegated_input_retirement_recovery_unverifiable')
        }
        if (status.inputEpoch === state.epoch) {
          await options.client.retireInput(
            {
              ...proof,
              destinationClaim: claim,
              inputIds: state.entries.map((entry) => entry.inputId),
              inputEpoch: state.epoch
            },
            { signal: options.signal }
          )
          assertCurrent()
        }
        if (JSON.stringify(options.inputJournal.loadDelegated(proof)) !== JSON.stringify(state)) {
          throw new Error('orcad_delegated_input_retirement_recovery_superseded')
        }
        return options.inputJournal.transitionDelegated(proof, {
          kind: 'complete-retirement',
          epoch: state.epoch
        })
      }),
    settleInput: (ptyId: string, inputId: string, inputEpoch: number) =>
      perform(ptyId, async () =>
        options.inputJournal.transitionDelegated(proof, {
          kind: 'settled',
          inputId,
          epoch: inputEpoch
        })
      ),
    retireInput: (ptyId: string, inputIds: readonly string[], inputEpoch: number) => {
      const ids = [...inputIds]
      return perform(ptyId, async (assertCurrent) => {
        const state = options.inputJournal.loadDelegated(proof)
        if (
          !state ||
          state.epoch !== inputEpoch ||
          ids.length !== state.entries.length ||
          new Set(ids).size !== ids.length ||
          state.entries.some((entry) => !ids.includes(entry.inputId))
        ) {
          throw new Error('orcad_delegated_input_retirement_mismatch')
        }
        options.inputJournal.transitionDelegated(proof, {
          kind: 'begin-retirement',
          epoch: inputEpoch
        })
        const result = await options.client.retireInput(
          { ...proof, destinationClaim: claim, inputIds: ids, inputEpoch },
          { signal: options.signal }
        )
        assertCurrent()
        options.inputJournal.transitionDelegated(proof, {
          kind: 'complete-retirement',
          epoch: inputEpoch
        })
        return result
      })
    },
    input: (ptyId: string, inputId: string, data: string, inputEpoch: number) =>
      perform(ptyId, async (assertCurrent) => {
        options.inputJournal.transitionDelegated(proof, {
          kind: 'attempt',
          epoch: inputEpoch,
          inputId,
          data
        })
        const result = await options.client.input(
          { ...proof, destinationClaim: claim, inputId, data, inputEpoch },
          { signal: options.signal }
        )
        assertCurrent()
        if (result.outcome === 'applied') {
          options.inputJournal.transitionDelegated(proof, {
            kind: 'applied',
            epoch: inputEpoch,
            inputId
          })
        }
        return result
      }),
    control: (
      ptyId: string,
      controlId: string,
      control: PtyOwnershipTransferControl,
      timeoutMs?: number
    ) => {
      const capturedControl = { ...control }
      return perform(ptyId, () =>
        options.client.control(
          { ...proof, destinationClaim: claim, controlId, control: capturedControl },
          { signal: options.signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
        )
      )
    }
  }
}
