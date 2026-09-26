import { ORCHESTRATION_FEDERATION_RECONCILE_ATTACHMENT_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import { WorkerDispatchParams } from '../../../../../../shared/rpc-contract/orchestration-worker-stop-params'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import { callFederatedWorkerShow, resolvePinnedFederatedServer } from './worker-observation'

const RECONCILE_LOST_RECEIPT =
  'Attachment reconcile was sent and its receipt was lost. Do not infer that no write occurred. Retry this same request id.'

export const ORCHESTRATION_WORKER_RECONCILE_ATTACHMENT_METHODS = [
  defineMethod({
    name: 'orchestration.workerReconcileAttachment',
    params: WorkerDispatchParams,
    handler: async (params, { runtime, orchestrationMutation }) => {
      if (!orchestrationMutation) {
        throw new OrchestrationError(
          'invalid_argument',
          'Remote attachment reconcile requires a durable retry request.'
        )
      }
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Dispatch ${params.dispatch} was not found.`
        )
      }
      const worker = db.getWorkerDispatch(params.dispatch)
      if (!worker || worker.state !== 'abandoned') {
        throw new OrchestrationError(
          'not_abandoned',
          `Dispatch ${params.dispatch} is ${worker?.state ?? 'unsupervised'}; abandon it before reconciling its remote attachment.`
        )
      }
      const federated = db.getFederatedDispatch(params.dispatch)
      if (!federated) {
        throw new OrchestrationError(
          'not_federated',
          `Dispatch ${params.dispatch} has no remote attachment to reconcile.`
        )
      }
      const server = resolvePinnedFederatedServer(runtime, federated)
      const status = await callPeer(
        runtime,
        server,
        'status.get',
        undefined,
        orchestrationMutation.requestId,
        false
      )
      if (
        !readCapabilities(status).includes(
          ORCHESTRATION_FEDERATION_RECONCILE_ATTACHMENT_RUNTIME_CAPABILITY
        )
      ) {
        throw new OrchestrationError(
          'capability_unsupported',
          `Connected server ${server.name} does not advertise attachment reconcile. Nothing was changed.`
        )
      }
      const show = await callFederatedWorkerShow(runtime, federated).catch((error: unknown) => {
        throw lostBeforeSend(error)
      })
      const expected = recordedIdentity(federated, show)
      let remote: unknown
      try {
        remote = await callPeer(
          runtime,
          server,
          'orchestration.federationReconcileAttachment',
          expected,
          orchestrationMutation.requestId,
          true
        )
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'method_not_found') {
          throw new OrchestrationError(
            'capability_unsupported',
            `Connected server ${server.name} rejected attachment reconcile. Nothing was changed.`
          )
        }
        if (error instanceof OrchestrationError) {
          throw error
        }
        throw new OrchestrationError(
          'reconcile_unknown',
          `${RECONCILE_LOST_RECEIPT} ${errorText(error)}`
        )
      }
      const parsed = readRemoteReceipt(remote, params.dispatch)
      if (!parsed) {
        throw new OrchestrationError(
          'reconcile_unknown',
          `${RECONCILE_LOST_RECEIPT} The execution host returned an unreadable receipt.`
        )
      }
      return {
        dispatchId: params.dispatch,
        state: 'abandoned' as const,
        alreadyReconciled: parsed.alreadyReconciled,
        processAction: 'none' as const,
        remoteAttachmentState: parsed.state,
        warning: parsed.alreadyReconciled
          ? 'The remote attachment was already reconciled. This call did not change it or stop the process. A lost earlier receipt does not prove the first call wrote nothing. Reconcile does not stop the agent turn or prove the work ceased; confirm cancel or hold before reusing the terminal.'
          : 'The remote attachment was retired and its capability was revoked. The terminal process was not closed. Reconcile does not stop the agent turn or prove the work ceased; confirm cancel or hold before reusing the terminal.'
      }
    }
  })
]

function recordedIdentity(
  federated: {
    dispatch_id: string
    remote_runtime_epoch: string | null
    remote_terminal_handle: string | null
  },
  show: Awaited<ReturnType<typeof callFederatedWorkerShow>>
) {
  const attachment = show.attachment
  const paneKey = stringField(attachment, 'pane_key')
  const processIncarnation = stringField(attachment, 'process_incarnation')
  const savedEpoch = federated.remote_runtime_epoch
  const savedHandle = federated.remote_terminal_handle
  if (
    stringField(attachment, 'state') === 'abandoned' &&
    'capability_hash' in attachment &&
    Reflect.get(attachment, 'capability_hash') === null &&
    savedEpoch &&
    savedHandle &&
    paneKey &&
    processIncarnation
  ) {
    return {
      dispatchId: federated.dispatch_id,
      expectedRuntimeEpoch: savedEpoch,
      expectedTerminalHandle: savedHandle,
      expectedPaneKey: paneKey,
      expectedProcessIncarnation: processIncarnation
    }
  }
  const attachmentEpoch = stringField(attachment, 'runtime_epoch')
  if (!savedEpoch || show.runtimeEpoch !== savedEpoch || attachmentEpoch !== savedEpoch) {
    throw new OrchestrationError(
      'runtime_epoch_mismatch',
      `Dispatch ${federated.dispatch_id} remote runtime epoch does not match the saved peer. Nothing was changed.`
    )
  }
  if (show.observation.status === 'unverifiable') {
    throw new OrchestrationError(
      'unverifiable',
      `Dispatch ${federated.dispatch_id} remote liveness is unverifiable. Nothing was changed.`
    )
  }
  if (
    !savedHandle ||
    attachment.terminal_handle !== savedHandle ||
    terminalHandle(show.terminal) !== savedHandle ||
    !paneKey ||
    !processIncarnation ||
    !show.observation.exactWorker ||
    (show.observation.status !== 'live' && show.observation.status !== 'exited')
  ) {
    throw new OrchestrationError(
      'worker_identity_changed',
      `Dispatch ${federated.dispatch_id} remote terminal, pane, or process incarnation does not match the saved attachment. Nothing was changed.`
    )
  }
  return {
    dispatchId: federated.dispatch_id,
    expectedRuntimeEpoch: savedEpoch,
    expectedTerminalHandle: savedHandle,
    expectedPaneKey: paneKey,
    expectedProcessIncarnation: processIncarnation
  }
}

async function callPeer(
  runtime: Parameters<typeof resolvePinnedFederatedServer>[0],
  server: ReturnType<typeof resolvePinnedFederatedServer>,
  method: string,
  params: unknown,
  requestId: string,
  mutate: boolean
): Promise<unknown> {
  try {
    return await runtime.callOrchestrationWorkerServer(
      server.environmentId,
      method,
      params,
      30_000,
      mutate ? { orchestrationRequestId: requestId } : undefined,
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )
  } catch (error) {
    if (!mutate) {
      throw lostBeforeSend(error)
    }
    throw error
  }
}

function lostBeforeSend(error: unknown): OrchestrationError {
  if (error instanceof OrchestrationError && error.code === 'peer_changed') {
    return error
  }
  return new OrchestrationError(
    'reconcile_unknown',
    `The worker peer did not answer before attachment reconcile was sent. No remote write was attempted. Retry this same request id. ${errorText(error)}`
  )
}

function readCapabilities(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('capabilities' in value)) {
    return []
  }
  const capabilities = Reflect.get(value, 'capabilities')
  return Array.isArray(capabilities)
    ? capabilities.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function readRemoteReceipt(
  value: unknown,
  dispatchId: string
): { state: string; alreadyReconciled: boolean } | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const dispatch = stringField(value, 'dispatchId')
  const state = stringField(value, 'state')
  const processAction = stringField(value, 'processAction')
  const alreadyReconciled = Reflect.get(value, 'alreadyReconciled')
  if (
    dispatch !== dispatchId ||
    state !== 'abandoned' ||
    processAction !== 'none' ||
    typeof alreadyReconciled !== 'boolean'
  ) {
    return null
  }
  return { state, alreadyReconciled }
}

function stringField(value: object, key: string): string | null {
  if (!(key in value)) {
    return null
  }
  const found = Reflect.get(value, key)
  return typeof found === 'string' && found.length > 0 ? found : null
}

function terminalHandle(terminal: unknown): string | null {
  if (!terminal || typeof terminal !== 'object') {
    return null
  }
  return stringField(terminal, 'handle')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
