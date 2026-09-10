import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from './db'
import {
  areFederatedLifecycleSettlementsEqual,
  releaseFederatedAttachment,
  type FederatedLifecycleSettlement
} from './federation-lifecycle-settlement'
import { RpcDispatcher } from '../rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'

const rejected = (reason: string): FederatedLifecycleSettlement => ({
  action: 'rejected',
  code: 'worker_report_rejected',
  reason,
  authority: 'run_home'
})

describe('federated lifecycle settlement equality', () => {
  it('accepts exact duplicate rejection verdicts', () => {
    expect(areFederatedLifecycleSettlementsEqual(rejected('same'), rejected('same'))).toBe(true)
  })

  it.each([
    [rejected('first'), rejected('second')],
    [rejected('same'), { ...rejected('same'), code: 'different_code' }]
  ])('distinguishes rejection verdicts with different details', (left, right) => {
    expect(areFederatedLifecycleSettlementsEqual(left, right)).toBe(false)
  })

  it('distinguishes terminal outcomes', () => {
    expect(
      areFederatedLifecycleSettlementsEqual(
        { action: 'completed', authority: 'run_home' },
        { action: 'failed', authority: 'run_home' }
      )
    ).toBe(false)
  })
})

describe('federated worker release', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  function createSettledAttachment(databasePath = ':memory:'): {
    db: OrchestrationDb
    runtime: OrcaRuntimeService
    dispatchId: string
  } {
    const db = new OrchestrationDb(databasePath)
    databases.push(db)
    const dispatchId = 'dispatch_remote_release'
    db.createRemoteDispatchAttachment({
      dispatchId,
      taskId: 'task_remote_release',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 3,
      runtimeEpoch: 'worker_runtime',
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'remote_attach_request',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'remote_attach_payload'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'worker_runtime:pty:1',
      worktreeId: 'repo::remote',
      terminalHandle: 'term_remote_worker',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    db.markRemoteAttachmentReady(dispatchId)
    db.settleRemoteAttachmentInRelayTransaction(dispatchId, 'succeeded')
    return { db, runtime: configureRemoteRuntime(db), dispatchId }
  }

  function configureRemoteRuntime(db: OrchestrationDb): OrcaRuntimeService {
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      worktreeId: 'repo::remote',
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
      'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('worker_runtime:pty:1')
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      status: 'running',
      tail: [],
      entries: [],
      truncated: false,
      limited: false,
      nextCursor: '0'
    } as never)
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      tabId: 'tab-remote-worker',
      ptyKilled: true
    } as never)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    return runtime
  }

  function createHomeReleaseHarness(
    capabilities: string[] = [ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY]
  ): {
    db: OrchestrationDb
    runtime: OrcaRuntimeService
    dispatcher: RpcDispatcher
    dispatchId: string
    remoteCall: ReturnType<typeof vi.spyOn>
  } {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const run = db.createRun({
      objective: 'Remote release',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'Release remote terminal', runId: run.id })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 1,
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'environment_remote',
        environmentName: 'remote',
        peerFingerprint: 'remote_peer',
        protocolVersion: 3
      }
    })
    db.updateFederatedDispatchResources({
      dispatchId: dispatch.id,
      remoteRuntimeEpoch: 'worker_runtime',
      worktreeId: 'repo::remote',
      terminalHandle: 'term_remote_worker',
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'worker_runtime:pty:1'
    })
    db.recordWorkerStage({
      dispatchId: dispatch.id,
      stage: 'remote_input_accepted',
      worktreeId: 'repo::remote',
      terminalHandle: 'term_remote_worker'
    })
    db.markWorkerDispatchReady(dispatch.id)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer'
    } as never)
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return { runtimeId: 'worker_runtime', capabilities }
        }
        if (method === 'orchestration.federationRelease') {
          return {
            dispatchId: (params as { dispatchId: string }).dispatchId,
            runtimeEpoch: 'worker_runtime',
            state: 'released',
            processAction: 'closed_agent_terminal',
            attachment: {
              terminalHandle: 'term_remote_worker',
              paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              processIncarnation: 'worker_runtime:pty:1'
            }
          }
        }
        throw new Error(`Unexpected method ${method}`)
      })
    return {
      db,
      runtime,
      dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }),
      dispatchId: dispatch.id,
      remoteCall
    }
  }

  function releaseRequest(dispatchId: string, requestId: string) {
    return {
      id: `rpc_${requestId}`,
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: requestId,
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    }
  }

  it('routes one durable home mutation to the authoritative worker receipt', async () => {
    const { dispatcher, dispatchId, remoteCall } = createHomeReleaseHarness()

    const first = await dispatcher.dispatch(releaseRequest(dispatchId, 'release_retry'))
    const replay = await dispatcher.dispatch(releaseRequest(dispatchId, 'release_retry'))

    expect(first).toMatchObject({ ok: true, result: { state: 'released' } })
    expect(replay).toMatchObject({ ok: true, result: { state: 'released' } })
    const releaseCalls = remoteCall.mock.calls.filter(
      ([, method]) => method === 'orchestration.federationRelease'
    )
    expect(releaseCalls).toHaveLength(1)
    expect(releaseCalls[0]?.[4]).toEqual({ orchestrationRequestId: 'release_retry' })
  })

  it('returns capability-limited without sending a remote release to an old peer', async () => {
    const { dispatcher, dispatchId, remoteCall } = createHomeReleaseHarness([])

    const released = await dispatcher.dispatch(releaseRequest(dispatchId, 'legacy_release'))

    expect(released).toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'federation_unsupported' }
    })
    expect(remoteCall.mock.calls.map(([, method]) => method)).toEqual(['status.get'])
  })

  it('replays release_unknown when the worker server cannot be contacted', async () => {
    const { dispatcher, dispatchId, remoteCall } = createHomeReleaseHarness()
    remoteCall.mockRejectedValueOnce(new Error('worker server unavailable'))

    const unavailable = await dispatcher.dispatch(releaseRequest(dispatchId, 'offline_release'))
    const released = await dispatcher.dispatch(releaseRequest(dispatchId, 'offline_release'))

    expect(unavailable).toMatchObject({ ok: true, result: { state: 'release_unknown' } })
    expect(released).toMatchObject({ ok: true, result: { state: 'release_unknown' } })
    expect(
      remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationRelease')
    ).toHaveLength(0)
  })

  it.each([
    ['malformed', {}],
    [
      'mismatched',
      {
        dispatchId: 'different_dispatch',
        runtimeEpoch: 'worker_runtime',
        state: 'released',
        processAction: 'closed_agent_terminal',
        attachment: {
          terminalHandle: 'term_remote_worker',
          paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          processIncarnation: 'worker_runtime:pty:1'
        }
      }
    ],
    [
      'version-skewed',
      {
        dispatchId: 'dispatch_placeholder',
        runtimeEpoch: 'worker_runtime',
        state: 'released',
        processAction: 'none'
      }
    ]
  ])('keeps a %s remote release receipt release_unknown', async (kind, receipt) => {
    const { dispatcher, dispatchId, remoteCall } = createHomeReleaseHarness()
    remoteCall.mockImplementation(async (_environmentId, method, params) => {
      if (method === 'status.get') {
        return {
          runtimeId: 'worker_runtime',
          capabilities: [ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY]
        }
      }
      if (method === 'orchestration.federationRelease') {
        return {
          ...receipt,
          ...(kind === 'version-skewed'
            ? { dispatchId: (params as { dispatchId: string }).dispatchId }
            : {})
        }
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await expect(
      dispatcher.dispatch(releaseRequest(dispatchId, `invalid_${kind}`))
    ).resolves.toMatchObject({
      ok: true,
      result: { state: 'release_unknown', processAction: 'none' }
    })
  })

  it.each([
    ['wrong current epoch', { runtimeEpoch: 'worker_runtime_replaced' }],
    ['wrong serving epoch', { servingRuntimeEpoch: 'worker_runtime_replaced' }],
    [
      'wrong pane',
      {
        attachment: {
          terminalHandle: 'term_remote_worker',
          paneKey: 'tab_worker:replaced',
          processIncarnation: 'worker_runtime:pty:1'
        }
      }
    ],
    [
      'wrong incarnation',
      {
        attachment: {
          terminalHandle: 'term_remote_worker',
          paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          processIncarnation: 'worker_runtime:pty:replaced'
        }
      }
    ]
  ])('keeps a receipt with a %s release_unknown', async (_kind, override) => {
    const { dispatcher, dispatchId, remoteCall } = createHomeReleaseHarness()
    remoteCall.mockImplementation(async (_environmentId, method, params) => {
      if (method === 'status.get') {
        return {
          runtimeId: 'worker_runtime',
          capabilities: [ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY]
        }
      }
      if (method === 'orchestration.federationRelease') {
        return {
          dispatchId: (params as { dispatchId: string }).dispatchId,
          runtimeEpoch: 'worker_runtime',
          state: 'released',
          processAction: 'closed_agent_terminal',
          attachment: {
            terminalHandle: 'term_remote_worker',
            paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            processIncarnation: 'worker_runtime:pty:1'
          },
          ...override
        }
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await expect(
      dispatcher.dispatch(releaseRequest(dispatchId, `invalid_${_kind}`))
    ).resolves.toMatchObject({
      ok: true,
      result: { state: 'release_unknown', processAction: 'none' }
    })
  })

  it('accepts a new worker runtime epoch when the current status and receipt agree', async () => {
    const { db, dispatcher, dispatchId, remoteCall } = createHomeReleaseHarness()
    db.updateFederatedDispatchResources({
      dispatchId,
      remoteRuntimeEpoch: 'worker_runtime_previous',
      worktreeId: 'repo::remote',
      terminalHandle: 'term_remote_worker'
    })
    remoteCall.mockImplementation(async (_environmentId, method, params) => {
      if (method === 'status.get') {
        return {
          runtimeId: 'worker_runtime_reconnected',
          capabilities: [ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY]
        }
      }
      if (method === 'orchestration.federationRelease') {
        return {
          dispatchId: (params as { dispatchId: string }).dispatchId,
          runtimeEpoch: 'worker_runtime_reconnected',
          state: 'released',
          processAction: 'closed_agent_terminal',
          attachment: {
            terminalHandle: 'term_remote_worker',
            paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            processIncarnation: 'worker_runtime:pty:1'
          }
        }
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await expect(
      dispatcher.dispatch(releaseRequest(dispatchId, 'reconnected_release'))
    ).resolves.toMatchObject({
      ok: true,
      result: { state: 'released', processAction: 'closed_agent_terminal' }
    })
  })

  it('accepts immutable release effect evidence with a current serving attestation', async () => {
    const { dispatcher, dispatchId, remoteCall } = createHomeReleaseHarness()
    remoteCall.mockImplementation(async (_environmentId, method, params) => {
      if (method === 'status.get') {
        return {
          runtimeId: 'worker_runtime_reconnected',
          capabilities: [ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY]
        }
      }
      if (method === 'orchestration.federationRelease') {
        return {
          dispatchId: (params as { dispatchId: string }).dispatchId,
          runtimeEpoch: 'worker_runtime_that_closed',
          servingRuntimeEpoch: 'worker_runtime_reconnected',
          state: 'released',
          processAction: 'closed_agent_terminal',
          attachment: {
            terminalHandle: 'term_remote_worker',
            paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            processIncarnation: 'worker_runtime:pty:1'
          }
        }
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await expect(
      dispatcher.dispatch(releaseRequest(dispatchId, 'reattested_release'))
    ).resolves.toMatchObject({
      ok: true,
      result: { state: 'released', processAction: 'closed_agent_terminal' }
    })
  })

  it('rejects a re-paired peer before it can release the remote worker', async () => {
    const { dispatcher, dispatchId, runtime, remoteCall } = createHomeReleaseHarness()
    vi.mocked(runtime.resolveOrchestrationWorkerServer).mockReturnValue({
      environmentId: 'environment_remote',
      name: 'replacement',
      peerFingerprint: 'replacement_peer'
    } as never)

    const released = await dispatcher.dispatch(releaseRequest(dispatchId, 'repaired_release'))

    expect(released).toMatchObject({ ok: false, error: { code: 'peer_changed' } })
    expect(remoteCall).not.toHaveBeenCalled()
  })

  it('settles once and returns already_released after a worker runtime reconnect', async () => {
    const { db, runtime, dispatchId } = createSettledAttachment()

    await expect(
      Promise.all([
        releaseFederatedAttachment(runtime, dispatchId),
        releaseFederatedAttachment(runtime, dispatchId)
      ])
    ).resolves.toEqual([
      expect.objectContaining({ state: 'released' }),
      expect.objectContaining({ state: 'released' })
    ])
    expect(runtime.closeTerminal).toHaveBeenCalledOnce()

    const reconnectedRuntime = configureRemoteRuntime(db)
    await expect(releaseFederatedAttachment(reconnectedRuntime, dispatchId)).resolves.toMatchObject(
      {
        state: 'already_released'
      }
    )
    expect(reconnectedRuntime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment(dispatchId)?.stage).toBe('release_completed')
  })

  it('replays a persisted release request across a new worker dispatcher', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-federated-release-dispatcher-'))
    const databasePath = join(directory, 'orchestration.db')
    const { db, runtime, dispatchId } = createSettledAttachment(databasePath)
    const request = {
      id: 'rpc_persisted_release',
      authToken: 'home-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'persisted_release_request',
      method: 'orchestration.federationRelease',
      params: { dispatchId }
    }
    const firstDispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const effectRuntimeEpoch = runtime.getRuntimeId()

    await expect(
      firstDispatcher.dispatch(request, { authenticatedCallerFingerprint: 'home_peer' })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        state: 'released',
        runtimeEpoch: effectRuntimeEpoch,
        servingRuntimeEpoch: effectRuntimeEpoch,
        mutation: { replayed: false }
      }
    })
    expect(runtime.closeTerminal).toHaveBeenCalledOnce()
    databases.splice(databases.indexOf(db), 1)
    db.close()

    const reconnectedDb = new OrchestrationDb(databasePath)
    databases.push(reconnectedDb)
    const reconnectedRuntime = configureRemoteRuntime(reconnectedDb)
    const reconnectedDispatcher = new RpcDispatcher({
      runtime: reconnectedRuntime,
      methods: ORCHESTRATION_METHODS
    })
    const servingRuntimeEpoch = reconnectedRuntime.getRuntimeId()
    expect(servingRuntimeEpoch).not.toBe(effectRuntimeEpoch)

    await expect(
      reconnectedDispatcher.dispatch(request, { authenticatedCallerFingerprint: 'home_peer' })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        state: 'released',
        runtimeEpoch: effectRuntimeEpoch,
        servingRuntimeEpoch,
        mutation: { replayed: true }
      }
    })
    expect(reconnectedRuntime.closeTerminal).not.toHaveBeenCalled()
    await expect(
      reconnectedDispatcher.dispatch(
        { ...request, params: { dispatchId: 'different_dispatch' } },
        { authenticatedCallerFingerprint: 'home_peer' }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    reconnectedDb.close()
    databases.splice(databases.indexOf(reconnectedDb), 1)
    rmSync(directory, { recursive: true, force: true })
  })

  it('rejects a reminted pane or process without closing a replacement worker', async () => {
    const { runtime, dispatchId } = createSettledAttachment()
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue(
      'worker_runtime:pty:replacement'
    )

    await expect(releaseFederatedAttachment(runtime, dispatchId)).resolves.toMatchObject({
      state: 'retained',
      reason: 'identity_unproven'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('rejects an unpinned Run home before it can close the remote worker', async () => {
    const { runtime, dispatchId } = createSettledAttachment()
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationRelease'
    )
    if (!method) {
      throw new Error('federationRelease method was not registered')
    }

    await expect(
      method.handler({ dispatchId }, {
        runtime,
        authenticatedCallerFingerprint: 'different_home_peer',
        orchestrationMutation: {
          callerFingerprint: 'different_home_peer',
          requestId: 'wrong_home_release',
          method: 'orchestration.federationRelease',
          payloadHash: 'payload'
        }
      } as never)
    ).rejects.toThrow(`Remote Dispatch ${dispatchId} was not found for this Run home.`)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('requires a durable release request before touching the remote terminal', async () => {
    const { runtime, dispatchId } = createSettledAttachment()
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationRelease'
    )
    if (!method) {
      throw new Error('federationRelease method was not registered')
    }

    await expect(
      method.handler({ dispatchId }, {
        runtime,
        authenticatedCallerFingerprint: 'home_peer'
      } as never)
    ).rejects.toThrow('Federated worker release requires a durable retry request.')
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('keeps a close without process proof pending and retryable', async () => {
    const { db, runtime, dispatchId } = createSettledAttachment()
    vi.mocked(runtime.closeTerminal).mockResolvedValueOnce({
      handle: 'term_remote_worker',
      tabId: 'tab-remote-worker',
      ptyKilled: false
    } as never)
    vi.mocked(runtime.inspectTerminalProcessIncarnationLiveness).mockResolvedValueOnce(
      'unverifiable'
    )

    await expect(releaseFederatedAttachment(runtime, dispatchId)).resolves.toMatchObject({
      state: 'unverifiable'
    })
    expect(db.getRemoteDispatchAttachment(dispatchId)).toMatchObject({
      state: 'succeeded',
      stage: 'release_pending'
    })

    await expect(releaseFederatedAttachment(runtime, dispatchId)).resolves.toMatchObject({
      state: 'released'
    })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(2)
  })
})
