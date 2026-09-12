import type { OrcadDelegatedConnectionOptions } from './orcad-delegated-connection-contract'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { samePtyOwnershipTransferCommitReceipt } from '../../shared/pty-ownership-transfer-receipt-validation'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD } from '../../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { connectOrcadLocalRelay } from './orcad-local-relay-connection'
import { recoverOrcadDelegatedClaim } from './orcad-delegated-claim-recovery'
import { createOrcadDelegatedCommitReconciliation } from './orcad-delegated-commit-reconciliation'
import { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import { reconcileOrcadInitialModelBaseline } from './orcad-delegated-initial-model-ack'
import { installOrcadDelegatedOutputReceiver } from './orcad-delegated-output-receiver'
import { createOrcadDelegatedPtyOperations } from './orcad-delegated-pty-operations'
import { createOrcadDelegatedProviderAdapters } from './orcad-delegated-provider-adapters'
import { createOrcadDelegatedExecutionRefresh } from './orcad-delegated-execution-refresh'
import { createOrcadDelegatedExitDelivery } from './orcad-delegated-exit-delivery'
import { createOrcadDelegatedExecutionState } from './orcad-delegated-execution-state'
import { OrcadDelegatedProviderExits } from './orcad-delegated-provider-exits'

/** One claimed connection lifetime; the caller serializes replacements for this transfer. */
export async function connectOrcadDelegatedTransfer(options: OrcadDelegatedConnectionOptions) {
  const identity = Object.freeze({ ...options.identity })
  const source = options.store.loadDelegatedSource(identity)
  const output = options.outbox.load(identity)
  const snapshot = options.adapter.snapshot()
  if (
    !source ||
    !output ||
    !samePtyOwnershipTransferIdentity(snapshot.identity, identity) ||
    snapshot.surfaceBinding?.executionHostId !== 'local' ||
    snapshot.phase === 'aborted'
  ) {
    throw new Error('orcad_delegated_connection_destination_unavailable')
  }
  options.signal.throwIfAborted()
  let disposed = false
  let multiplexer: SshChannelMultiplexer | undefined
  let receiver: ReturnType<typeof installOrcadDelegatedOutputReceiver> | undefined
  let providerAdapters: ReturnType<typeof createOrcadDelegatedProviderAdapters> | undefined
  let executionRefresh: ReturnType<typeof createOrcadDelegatedExecutionRefresh> | undefined
  let executionState: ReturnType<typeof createOrcadDelegatedExecutionState> | undefined
  let finalOutputSeq: number | undefined
  let destinationClaim: PtyOwnershipTransferDestinationClaim | undefined
  let removeDispose = () => {}
  const active = () => !disposed && !options.signal.aborted
  const providerExits = new OrcadDelegatedProviderExits({ ...options, isActive: active })
  let stopping: Promise<void> | undefined
  const dispose = () => {
    if (disposed) {
      return stopping
    }
    disposed = true
    providerExits.dispose()
    options.signal.removeEventListener('abort', dispose)
    removeDispose()
    stopping = Promise.all([
      receiver?.dispose(),
      providerAdapters?.providerInput.whenIdle(),
      executionRefresh?.dispose()
    ]).then(() => undefined)
    executionState?.disconnect()
    if (!executionState && destinationClaim) {
      options.adapter.markDelegatedExecutionUnverifiable(destinationClaim)
    }
    multiplexer?.dispose()
    return stopping
  }
  const assertActive = () => {
    if (!active()) {
      throw new Error('orcad_delegated_connection_stale')
    }
  }
  options.signal.addEventListener('abort', dispose, { once: true })
  try {
    if (options.initializeModel) {
      await options.initializeModel(options.signal)
      assertActive()
    }
    multiplexer = await connectOrcadLocalRelay({
      endpoint: source.endpoint,
      incumbentVersion: source.incumbentVersion,
      endpointCredential: source.endpointCredential,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      initialize: (connection) => {
        multiplexer = connection
        removeDispose = connection.onDispose(dispose)
      }
    })
    assertActive()
    const transport = multiplexer
    const client = new OrcadDelegatedTransferClient((method, params, requestOptions) => {
      assertActive()
      return transport.request(method, { ...params }, requestOptions)
    })
    destinationClaim = await recoverOrcadDelegatedClaim({
      identity,
      store: options.store,
      client,
      isActive: active,
      createClaimId: options.createClaimId,
      requestOptions: { signal: options.signal, timeoutMs: options.timeoutMs }
    })
    assertActive()
    options.adapter.bindDelegatedExecution(destinationClaim)
    const status = await reconcileOrcadInitialModelBaseline({
      proof: source.proof,
      claim: destinationClaim,
      client,
      outbox: options.outbox,
      isActive: active,
      requestOptions: { signal: options.signal, timeoutMs: options.timeoutMs }
    })
    assertActive()
    // Older sources omit this cursor; retain their existing exact-subscribe refusal on ACK skew.
    const afterSeq = status.destinationAcknowledgedSeq ?? output.acceptedEndSeq
    if (afterSeq < output.baseEndSeq || afterSeq > output.acceptedEndSeq) {
      throw new Error('orcad_delegated_connection_output_cursor_conflict')
    }
    const proof = Object.freeze({
      ...source.proof,
      destinationClaim,
      afterSeq
    })
    let subscribedToOutput = false
    const reconciliation = createOrcadDelegatedCommitReconciliation({
      identity,
      store: options.store,
      client,
      claim: destinationClaim,
      isActive: () => active() && subscribedToOutput,
      requestOptions: { signal: options.signal, timeoutMs: options.timeoutMs },
      onError: options.onError,
      onReconciled: () => {
        executionRefresh?.wake()
        executionState?.wake()
      }
    })
    // No output route exists before subscribe; install before its response can coalesce with output.
    receiver = installOrcadDelegatedOutputReceiver({
      multiplexer: transport,
      outbox: options.outbox,
      proof,
      baseEndSeq: output.baseEndSeq,
      isActive: active,
      onError: options.onError,
      onAcknowledged: reconciliation.wake,
      onDrained: () => {
        executionRefresh?.wake()
        executionState?.wake()
      },
      onExecutionChanged: (seq) => {
        finalOutputSeq = seq
        executionRefresh?.request(seq)
      },
      destinationAdapter: options.adapter,
      prepareModelFrame: options.prepareModelFrame
    })
    const subscribed = await transport.request(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD,
      { ...proof, executionNotifications: 1 },
      { signal: options.signal, timeoutMs: options.timeoutMs }
    )
    assertActive()
    const response = subscribed as Record<string, unknown> | null
    if (
      !response ||
      !samePtyOwnershipTransferIdentity(
        parsePtyOwnershipTransferWireIdentity(response),
        identity
      ) ||
      response.version !== 1 ||
      response.subscribed !== true ||
      response.afterSeq !== proof.afterSeq
    ) {
      throw new Error('orcad_delegated_connection_subscription_invalid')
    }
    subscribedToOutput = true
    reconciliation.wake()
    const deliverExit = createOrcadDelegatedExitDelivery({
      proof,
      adapter: options.adapter,
      outbox: options.outbox,
      isActive: active,
      onExit: providerExits.accept
    })
    executionState = createOrcadDelegatedExecutionState({
      ...options,
      identity,
      client,
      proof: source.proof,
      claim: destinationClaim,
      deliverExit,
      isActive: active,
      invalidate: dispose,
      isReady: () => {
        const output = options.outbox.load(identity)
        return (
          reconciliation.isReconciled() &&
          !!output &&
          output.pendingFrames.length === 0 &&
          output.acceptedEndSeq === output.acknowledgedEndSeq
        )
      }
    })
    const refreshExecution = executionState.refresh
    executionState.wake()
    executionRefresh = createOrcadDelegatedExecutionRefresh({
      probeFinalOutputSeq:
        response.executionNotifications === 1
          ? undefined
          : async () => {
              if (
                !reconciliation.isReconciled() ||
                options.adapter.snapshot().phase !== 'published'
              ) {
                return null
              }
              const status = await client.status(source.proof, {
                signal: options.signal,
                timeoutMs: options.timeoutMs
              })
              assertActive()
              const current = options.adapter.snapshot()
              if (
                !status.boundToConnection ||
                status.destinationClaim?.generation !== destinationClaim!.generation ||
                status.destinationClaim.claimId !== destinationClaim!.claimId ||
                status.phase !== 'committed' ||
                !status.receipt ||
                !current.publicationReceipt ||
                !samePtyOwnershipTransferCommitReceipt(
                  status.receipt,
                  current.publicationReceipt.commitReceipt
                )
              ) {
                throw new Error('orcad_delegated_exit_probe_unverifiable')
              }
              return status.executionVerdict === 'exited' && status.exit
                ? (status.sourceOutputEndSeq ?? null)
                : null
            },
      isActive: active,
      isReady: (seq) => {
        const output = options.outbox.load(identity)
        return (
          reconciliation.isReconciled() &&
          options.adapter.snapshot().phase === 'published' &&
          output?.acknowledgedEndSeq === seq &&
          output.acceptedEndSeq === seq &&
          output.pendingFrames.length === 0
        )
      },
      refresh: async () => {
        const snapshot = await refreshExecution()
        if (snapshot.executionVerdict !== 'exited') {
          throw new Error('orcad_delegated_exit_not_confirmed')
        }
      },
      onError: options.onError
    })
    if (finalOutputSeq !== undefined) {
      executionRefresh.request(finalOutputSeq)
    }
    const operations = createOrcadDelegatedPtyOperations({
      client,
      adapter: options.adapter,
      inputJournal: options.store.input,
      proof,
      claim: destinationClaim,
      signal: options.signal,
      isActive: active,
      isCommitReconciled: reconciliation.isReconciled
    })
    providerAdapters = createOrcadDelegatedProviderAdapters(
      { ...options, identity },
      operations,
      active
    )
    return {
      onExit: providerExits.onExit,
      operations,
      ...providerAdapters,
      client,
      multiplexer: transport,
      proof,
      receiver,
      isActive: active,
      refreshExecution,
      retryCommit: reconciliation.wake,
      waitForCommitReconciled: reconciliation.waitForReconciled,
      isCommitReconciled: reconciliation.isReconciled,
      dispose
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
