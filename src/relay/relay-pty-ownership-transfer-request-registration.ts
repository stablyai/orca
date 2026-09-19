import type { RelayDispatcher, RequestContext } from './dispatcher'
import { registerRelayPtySuccessorRetirement } from './relay-pty-successor-retirement-registration'
import { PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD } from '../shared/pty-ownership-transfer-source-retirement'
import { supportsRelayPtySourceRetirement } from './relay-pty-source-retirement-capability'
import { retireRelayPtySourceDelivery } from './relay-pty-source-retirement-execution'
import { PTY_OWNERSHIP_CAPTURE_IMPORT_ACK_METHOD } from '../shared/pty-ownership-capture-import-receipt'
import { acknowledgeRelayPtyOwnershipCaptureImport } from './relay-pty-ownership-transfer-capture-import-ack'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_PROCESS_METHOD } from '../shared/pty-ownership-transfer-destination-process'
import { inspectRelayPtyOwnershipTransferDestinationProcess } from './relay-pty-ownership-transfer-destination-process'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_CWD_METHOD } from '../shared/pty-ownership-transfer-destination-cwd'
import { inspectRelayPtyOwnershipTransferDestinationCwd } from './relay-pty-ownership-transfer-destination-cwd'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD } from '../shared/pty-ownership-transfer-destination-control'
import { applyRelayPtyOwnershipTransferDelegatedControl } from './relay-pty-ownership-transfer-destination-control'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_RETIRE_INPUT_METHOD
} from '../shared/pty-ownership-transfer-destination-input'
import { retireRelayPtyOwnershipTransferDestinationInput } from './relay-pty-ownership-transfer-destination-input-retirement'
import { acceptRelayPtyOwnershipTransferDestinationInput } from './relay-pty-ownership-transfer-destination-input'
import { commitRelayPtyOwnershipTransferDestination } from './relay-pty-ownership-transfer-destination-commit'
import { registerRelayPtyDestinationOutputSubscriptions } from './relay-pty-ownership-transfer-destination-output-subscription'
import type { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import {
  PTY_OWNERSHIP_TRANSFER_METHODS,
  parsePtyOwnershipTransferWireIdentity
} from '../shared/pty-ownership-transfer-wire'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_REPLAY_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_RECOVER_METHOD
} from '../shared/pty-ownership-transfer-destination-claim'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import {
  replayRelayPtyOwnershipTransferDestination,
  acknowledgeRelayPtyOwnershipTransferDestinationOutput
} from './relay-pty-ownership-transfer-destination-claim'

export function registerRelayPtyOwnershipTransferRequests(
  dispatcher: RelayDispatcher,
  adapter: RelayPtyOwnershipTransferAdapter,
  state: RelayPtyOwnershipTransferAdapterState,
  authorize: (
    method: string,
    params: Record<string, unknown>,
    context: RequestContext
  ) => Promise<void>
): void {
  registerRelayPtyDestinationOutputSubscriptions(state, dispatcher)
  registerRelayPtySuccessorRetirement(dispatcher, state)
  dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, async (params, context) => {
    await authorize(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, params, context)
    return adapter.prepare(params)
  })
  dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.replay, async (params, context) => {
    await authorize(PTY_OWNERSHIP_TRANSFER_METHODS.replay, params, context)
    return adapter.replay(params, context)
  })
  dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.commit, async (params, context) => {
    await authorize(PTY_OWNERSHIP_TRANSFER_METHODS.commit, params, context)
    return adapter.commit(params)
  })
  dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.publish, async (params, context) => {
    await authorize(PTY_OWNERSHIP_TRANSFER_METHODS.publish, params, context)
    return adapter.publish(params)
  })
  adapter.registerStatus(dispatcher)
  dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.input, async (params, context) => {
    await authorize(PTY_OWNERSHIP_TRANSFER_METHODS.input, params, context)
    return adapter.acceptInput(params)
  })
  dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.retireInput, async (params, context) => {
    await authorize(PTY_OWNERSHIP_TRANSFER_METHODS.retireInput, params, context)
    return adapter.retireInput(params)
  })
  dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.attach, async (params, context) => {
    await authorize(PTY_OWNERSHIP_TRANSFER_METHODS.attach, params, context)
    return adapter.attach(params, context)
  })
  dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.rekeyReconnect, async (params, context) => {
    await authorize(PTY_OWNERSHIP_TRANSFER_METHODS.rekeyReconnect, params, context)
    return adapter.rekeyReconnect(params, context)
  })
  dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.control, async (params, context) => {
    await authorize(PTY_OWNERSHIP_TRANSFER_METHODS.control, params, context)
    return await adapter.control(params, context)
  })
  dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.abort, async (params, context) => {
    await authorize(PTY_OWNERSHIP_TRANSFER_METHODS.abort, params, context)
    return adapter.abort(params)
  })
  // A reconnect reuses the primary client id but advances its transport generation.  Retire
  // bindings at detach so an old attachment cannot publish controls through a later socket.
  const detach = (
    dispatcher as unknown as {
      onClientDetached?: (listener: (clientId: number) => void) => () => void
    }
  ).onClientDetached?.bind(dispatcher)
  detach?.((clientId) => {
    for (const transfer of state.transfers.values()) {
      if (transfer.destinationClaimBinding?.clientId === clientId) {
        transfer.destinationClaimBinding = undefined
      }
      if (transfer.attachmentBinding?.clientId === clientId) {
        transfer.attachmentBinding = undefined
        // Do not emit an exit (or route output) to a socket that has already detached.
        transfer.attachmentId = undefined
        // Persist the detach fence so a relay restart cannot resurrect a stale attachment route.
        try {
          persistRelayPtyOwnershipTransfer(state, transfer)
        } catch {
          // A failed persistence leaves the in-memory route detached and therefore fail-closed.
        }
      }
    }
  })
  if (state.options.enableDestinationDelegationClaims) {
    if (supportsRelayPtySourceRetirement(state.options)) {
      dispatcher.onRequest(
        PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD,
        async (params, context) => {
          if (!supportsRelayPtySourceRetirement(state.options)) {
            throw new Error('pty_source_retirement_unavailable')
          }
          return retireRelayPtySourceDelivery(state, params, context, (expectedDelivery) =>
            state.options.prepareSourceDeliveryRetirement!(
              parsePtyOwnershipTransferWireIdentity(params),
              expectedDelivery
            )
          )
        }
      )
    }
    if (state.options.inspectDestinationProcess) {
      dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_DESTINATION_PROCESS_METHOD, (params, context) =>
        inspectRelayPtyOwnershipTransferDestinationProcess(state, params, context)
      )
    }
    if (state.options.inspectDestinationCwd) {
      dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_DESTINATION_CWD_METHOD, (params, context) =>
        inspectRelayPtyOwnershipTransferDestinationCwd(state, params, context)
      )
    }
    if (state.options.enableDestinationDelegationControl) {
      dispatcher.onRequest(
        PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD,
        async (params, context) =>
          applyRelayPtyOwnershipTransferDelegatedControl(state, params, context)
      )
    }
    if (state.options.enableDestinationDelegationInput) {
      dispatcher.onRequest(
        PTY_OWNERSHIP_TRANSFER_DESTINATION_RETIRE_INPUT_METHOD,
        async (params, context) =>
          retireRelayPtyOwnershipTransferDestinationInput(state, params, context)
      )
      dispatcher.onRequest(
        PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD,
        async (params, context) =>
          acceptRelayPtyOwnershipTransferDestinationInput(state, params, context)
      )
    }
    if (
      state.options.enableDestinationDelegationCommit &&
      state.options.enableDestinationOutputRetention &&
      state.options.enableDestinationOutputRoutes
    ) {
      dispatcher.onRequest(
        PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD,
        async (params, context) =>
          commitRelayPtyOwnershipTransferDestination(state, params, context)
      )
    }
    if (state.options.enableDestinationOutputRetention) {
      if (state.options.enableCaptureImportAcknowledgement) {
        dispatcher.onRequest(PTY_OWNERSHIP_CAPTURE_IMPORT_ACK_METHOD, async (params, context) =>
          acknowledgeRelayPtyOwnershipCaptureImport(state, params, context)
        )
      }
      dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD, async (params, context) =>
        acknowledgeRelayPtyOwnershipTransferDestinationOutput(state, params, context)
      )
    }
    dispatcher.onRequest(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_REPLAY_METHOD,
      async (params, context) => replayRelayPtyOwnershipTransferDestination(state, params, context)
    )
    dispatcher.onRequest(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_RECOVER_METHOD,
      async (params, context) => adapter.recoverDestination(params, context)
    )
    dispatcher.onRequest(
      PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD,
      async (params, context) => adapter.inspectDestination(params, context)
    )
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD, async (params, context) =>
      adapter.claimDestination(params, context)
    )
  }
}
