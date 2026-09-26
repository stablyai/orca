import { vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/environment-transport'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { fingerprintAuthenticatedPairingCredential } from '../../../orchestration-mutation-executor'

export function createRunHomePair(protocolVersion: number, legacyHome = false) {
  const homeToken = 'home-token'
  const homeFingerprint = fingerprintAuthenticatedPairingCredential(homeToken)
  const workerDb = new OrchestrationDb(':memory:')
  const workerRuntime = new OrcaRuntimeService()
  workerRuntime.setOrchestrationDb(workerDb)
  const workerDispatcher = new RpcDispatcher({
    runtime: workerRuntime,
    methods: ORCHESTRATION_METHODS
  })
  const contact = { available: true, peerFingerprint: 'worker-peer' }
  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => ({
      environmentId: 'worker',
      name: 'worker',
      peerFingerprint: contact.peerFingerprint
    }),
    call: async (_selector, method, params, _timeout, envelope) => {
      if (!contact.available) {
        throw new Error('host unavailable')
      }
      if (method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: workerRuntime.getStatus(),
          _meta: { runtimeId: workerRuntime.getRuntimeId() }
        }
      }
      return workerDispatcher.dispatch(
        {
          id: `peer_${method}`,
          authToken: homeToken,
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId
        },
        { authenticatedCallerFingerprint: homeFingerprint }
      )
    }
  }
  const homeDb = new OrchestrationDb(':memory:')
  const homeRuntime = new OrcaRuntimeService(null, undefined, {
    orchestrationEnvironmentTransport: transport
  })
  homeRuntime.setOrchestrationDb(homeDb)
  const homeDispatcher = new RpcDispatcher({ runtime: homeRuntime, methods: ORCHESTRATION_METHODS })
  const coordinatorPane = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPane = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_coord' ? coordinatorPane : null
  )
  vi.spyOn(homeRuntime, 'notifyMessageArrived').mockImplementation(() => {})
  vi.spyOn(workerRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_worker'
      ? workerPane
      : handle === 'term_unbound'
        ? 'tab_unbound:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        : null
  )
  vi.spyOn(workerRuntime, 'getTerminalProcessIncarnation').mockReturnValue('worker:pty:1')
  const run = homeDb.createRun({
    objective: 'Two-host routing',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: coordinatorPane
  })
  const task = homeDb.createTask({ spec: 'Report status', runId: run.id })
  const { dispatch } = homeDb.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 5,
    taskId: task.id,
    startOptions: {},
    federation: {
      environmentId: 'worker',
      environmentName: 'worker',
      peerFingerprint: 'worker-peer',
      protocolVersion
    }
  })
  homeDb.markWorkerDispatchReady(dispatch.id)
  workerDb.createRemoteDispatchAttachment({
    ...(legacyHome ? {} : { runId: run.id }),
    dispatchId: dispatch.id,
    taskId: task.id,
    homePeerFingerprint: homeFingerprint,
    protocolVersion,
    runtimeEpoch: workerRuntime.getRuntimeId(),
    mutationReceipt: {
      callerFingerprint: homeFingerprint,
      requestId: 'attach',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'attach'
    }
  })
  const capability = workerDb.prepareRemoteAttachmentAuthority({
    dispatchId: dispatch.id,
    paneKey: workerPane,
    processIncarnation: 'worker:pty:1',
    worktreeId: 'folder:worker',
    terminalHandle: 'term_worker',
    setupState: 'not_applicable',
    effects: []
  })
  workerDb.markRemoteAttachmentReady(dispatch.id)

  function send(
    requestId: string,
    overrides: Record<string, unknown> = {},
    token: string | null = capability
  ) {
    return workerDispatcher.dispatch({
      id: requestId,
      authToken: 'worker-token',
      method: 'orchestration.send',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: requestId,
      ...(token ? { orchestrationCapability: token } : {}),
      params: { from: 'term_worker', subject: 'Progress', ...overrides }
    })
  }
  return {
    homeDb,
    workerDb,
    homeRuntime,
    workerRuntime,
    homeDispatcher,
    workerDispatcher,
    contact,
    run,
    dispatch,
    send,
    close: () => {
      homeRuntime.stopOrchestrationFederationRelay()
      workerRuntime.stopOrchestrationFederationRelay()
      homeDb.close()
      workerDb.close()
    }
  }
}
