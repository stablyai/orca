import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/environment-transport'
import type { RpcRequest } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { registerFederatedReleaseRecoveryScenarios } from './federation-release-recovery-scenarios.test-support'

describe('orchestration federated worker output', () => {
  const databases: OrchestrationDb[] = []
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let workerDbDirectory: string
  let workerDbPath: string
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let workerSupportsStructuredRead: boolean
  let workerFleetUnavailable: boolean
  let workerReleaseUnavailable: boolean
  let workerAdvertisesNewCapabilities: boolean
  let workerAdvertisesDurableRelease: boolean
  let workerTerminalAvailable: boolean
  let remoteCalls: string[]

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDbDirectory = mkdtempSync(join(tmpdir(), 'orca-federated-output-db-'))
    workerDbPath = join(workerDbDirectory, 'worker.db')
    workerDb = new OrchestrationDb(workerDbPath)
    databases.push(homeDb, workerDb)
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
    workerSupportsStructuredRead = true
    workerFleetUnavailable = false
    workerReleaseUnavailable = false
    workerAdvertisesNewCapabilities = true
    workerAdvertisesDurableRelease = true
    workerTerminalAvailable = true
    remoteCalls = []
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: 'windows_peer_fingerprint'
      }),
      call: async (_selector, method, params, _timeoutMs, envelope) => {
        remoteCalls.push(method)
        if (method === 'status.get') {
          const status = workerRuntime.getStatus()
          return {
            id: 'status',
            ok: true,
            result: {
              ...status,
              capabilities: status.capabilities?.filter(
                (capability) =>
                  !(
                    (!workerAdvertisesNewCapabilities &&
                      [
                        ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY,
                        ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
                        ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY
                      ].includes(capability as never)) ||
                    ((!workerAdvertisesNewCapabilities || !workerAdvertisesDurableRelease) &&
                      capability === ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY)
                  )
              )
            },
            _meta: { runtimeId: workerRuntime.getRuntimeId() }
          }
        }
        if (method === 'orchestration.federationReadOutput' && !workerSupportsStructuredRead) {
          return {
            id: `remote_${method}`,
            ok: false,
            error: { code: 'method_not_found', message: `Unknown method: ${method}` }
          }
        }
        if (
          method === 'orchestration.federationFleetSnapshot' &&
          !workerAdvertisesNewCapabilities
        ) {
          // A host old enough to lack the capability lacks the method too.
          return {
            id: `remote_${method}`,
            ok: false,
            error: { code: 'method_not_found', message: `Unknown method: ${method}` }
          }
        }
        if (method === 'orchestration.federationFleetSnapshot' && workerFleetUnavailable) {
          return {
            id: `remote_${method}`,
            ok: false,
            error: { code: 'relay_provider_unavailable', message: 'relay unavailable' }
          }
        }
        if (method === 'orchestration.federationRelease' && workerReleaseUnavailable) {
          return {
            id: `remote_${method}`,
            ok: false,
            error: { code: 'relay_provider_unavailable', message: 'relay unavailable' }
          }
        }
        return (await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          orchestrationCapability: envelope?.orchestrationCapability
        })) as RuntimeRpcResponse<unknown>
      }
    }
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    homeDispatcher = new RpcDispatcher({
      runtime: homeRuntime,
      methods: ORCHESTRATION_METHODS
    })
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null
    )
    configureWorkerRuntime(workerRuntime)
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    for (const db of databases.splice(0)) {
      db.close()
    }
    rmSync(workerDbDirectory, { recursive: true, force: true })
  })

  function createHomeTask(runId?: string) {
    const run = runId
      ? { id: runId }
      : homeDb.createRun({
          objective: 'Mac to Windows output',
          coordinatorHandle: 'term_coord',
          coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        })
    return homeDb.createTask({ spec: 'Read Windows worker output', runId: run.id })
  }

  function startRequest(taskId: string): RpcRequest {
    return {
      id: 'rpc_worker_start',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_windows_worker',
      method: 'orchestration.workerStart',
      params: {
        task: taskId,
        from: 'term_coord',
        on: 'windows',
        worktree: 'new-top-level',
        repo: 'id:windows-repo',
        name: 'windows-output',
        agent: 'codex'
      }
    }
  }

  function configureWorkerRuntime(runtime: OrcaRuntimeService): void {
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'windows-repo',
      kind: 'git'
    } as never)
    vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_windows_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    } as never)
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [{ handle: 'term_windows_worker', title: 'Codex' }],
      totalCount: 1,
      truncated: false
    } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
      'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('windows_runtime:pty:1')
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_windows_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async () => {
      if (!workerTerminalAvailable) {
        throw new Error('terminal_handle_stale')
      }
      return {
        handle: 'term_windows_worker',
        worktreeId: 'repo::windows-worktree',
        status: 'running'
      } as never
    })
    // The execution host must publish a positive liveness verdict; a missing
    // verdict is intentionally treated as unverifiable for old peers.
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: ['term_windows_worker']
    })
    vi.spyOn(runtime, 'readTerminal').mockImplementation(async () => {
      if (!workerTerminalAvailable) {
        throw new Error('terminal_handle_stale')
      }
      return {
        handle: 'term_windows_worker',
        status: 'running',
        tail: ['remote output'],
        truncated: false,
        nextCursor: '1'
      }
    })
    vi.spyOn(runtime, 'closeTerminal').mockImplementation(async () => {
      workerTerminalAvailable = false
      return { ptyKilled: true } as never
    })
  }

  function restartWorkerRuntime(reopenDb = false): void {
    if (reopenDb) {
      workerDb.close()
      databases.splice(databases.indexOf(workerDb), 1)
      workerDb = new OrchestrationDb(workerDbPath)
      databases.push(workerDb)
    }
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    configureWorkerRuntime(workerRuntime)
    workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
  }

  async function startRemoteWorker(): Promise<string> {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    return homeDb.getDispatchContext(task.id)!.id
  }

  async function startSettledRemoteWorker(): Promise<string> {
    const dispatchId = await startRemoteWorker()
    const taskId = homeDb.getDispatchContextById(dispatchId)!.task_id
    expect(
      homeDb.settleWorkerReport({
        taskId,
        dispatchId,
        outcome: 'succeeded',
        result: 'remote worker succeeded'
      })
    ).toMatchObject({ action: 'settled', outcome: 'succeeded' })
    workerDb.settleRemoteAttachmentInRelayTransaction(
      dispatchId,
      'succeeded',
      'worker_report_settled'
    )
    expect(homeDb.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'succeeded',
      stage: 'settled'
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)).toMatchObject({
      state: 'succeeded',
      stage: 'worker_report_settled'
    })
    return dispatchId
  }

  it('routes show and read by Dispatch without repeating the worker server', async () => {
    const dispatchId = await startRemoteWorker()

    const shown = await homeDispatcher.dispatch({
      id: 'rpc_remote_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatchId }
    })
    const read = await homeDispatcher.dispatch({
      id: 'rpc_remote_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId, limit: 20 }
    })

    expect(shown).toMatchObject({
      ok: true,
      result: {
        server: { environmentId: 'environment_windows', name: 'windows' },
        observation: { status: 'live', exactWorker: true },
        terminal: { handle: 'term_windows_worker' }
      }
    })
    expect(read).toMatchObject({
      ok: true,
      result: {
        source: 'terminal',
        fallbackReason: 'session_not_reported',
        server: { environmentId: 'environment_windows', name: 'windows' },
        terminal: { tail: ['remote output'] }
      }
    })
  })

  it('keeps an opaque terminal cursor across mixed server versions', async () => {
    const dispatchId = await startRemoteWorker()
    workerSupportsStructuredRead = false
    remoteCalls = []

    const automatic = await homeDispatcher.dispatch({
      id: 'rpc_remote_legacy_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId }
    })
    const cursor = (automatic as { result: { cursor: string } }).result.cursor
    const continued = await homeDispatcher.dispatch({
      id: 'rpc_remote_legacy_continue',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId, cursor }
    })
    const required = await homeDispatcher.dispatch({
      id: 'rpc_remote_legacy_transcript',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId, source: 'transcript' }
    })

    expect(automatic).toMatchObject({
      ok: true,
      result: {
        source: 'terminal',
        fallbackReason: 'remote_capability_unavailable',
        terminal: { tail: ['remote output'] }
      }
    })
    expect(cursor).toMatch(/^owr1_/)
    expect(continued).toMatchObject({
      ok: true,
      result: {
        source: 'terminal',
        fallbackReason: 'remote_capability_unavailable'
      }
    })
    expect((continued as { result: { cursor: string } }).result.cursor).toMatch(/^owr1_/)
    expect(required).toMatchObject({
      ok: false,
      error: {
        code: 'transcript_required',
        data: { reason: 'remote_capability_unavailable' }
      }
    })
    // The worker-start capability negotiation already populated this epoch's
    // cache; mixed-version fallback must not issue a redundant status probe.
    expect(remoteCalls.filter((method) => method === 'status.get')).toHaveLength(0)
    expect(
      remoteCalls.filter((method) => method === 'orchestration.federationReadOutput')
    ).toHaveLength(1)
  })

  it('reads the exact transcript on the worker server without leaking its path home', async () => {
    const dispatchId = await startRemoteWorker()
    const directory = await mkdtemp(join(tmpdir(), 'orca-federated-worker-output-'))
    const transcriptPath = join(directory, 'windows-session.jsonl')
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'event_msg',
        payload: { id: 'remote-message', type: 'agent_message', message: 'Windows result' }
      })}\n`
    )
    vi.spyOn(workerRuntime, 'getExactWorkerProviderSession').mockReturnValue({
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'windows_runtime:pty:1',
      agent: 'codex',
      providerSession: {
        key: 'session_id',
        id: 'windows-session',
        transcriptPath
      },
      observedAt: Date.now()
    })

    try {
      const response = await homeDispatcher.dispatch({
        id: 'rpc_remote_transcript_read',
        authToken: 'coordinator-token',
        method: 'orchestration.workerRead',
        params: { dispatch: dispatchId }
      })

      expect(response).toMatchObject({
        ok: true,
        result: {
          source: 'transcript',
          provider: 'codex',
          server: { environmentId: 'environment_windows' },
          transcript: {
            messages: [
              {
                id: 'remote-message',
                blocks: [{ type: 'text', text: 'Windows result' }]
              }
            ]
          }
        }
      })
      expect(JSON.stringify(response)).not.toContain(transcriptPath)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('batches fleet observations per host and keeps relay loss unverifiable', async () => {
    const firstDispatchId = await startRemoteWorker()
    remoteCalls = []

    const healthy = await homeDispatcher.dispatch({
      id: 'rpc_remote_fleet',
      authToken: 'coordinator-token',
      method: 'orchestration.workerList',
      params: { includeRemote: true }
    })

    expect(
      remoteCalls.filter((method) => method === 'orchestration.federationFleetSnapshot')
    ).toHaveLength(1)
    expect(healthy).toMatchObject({ ok: true })
    const healthyWorker = (
      healthy as { result: { workers: { dispatchId: string; projection: unknown }[] } }
    ).result.workers.find((worker) => worker.dispatchId === firstDispatchId)
    expect(healthyWorker?.projection).toMatchObject({
      host: { kind: 'remote', id: 'environment_windows' },
      liveness: { verdict: 'live', source: 'execution_host' }
    })

    workerFleetUnavailable = true
    const unavailable = await homeDispatcher.dispatch({
      id: 'rpc_remote_fleet_unavailable',
      authToken: 'coordinator-token',
      method: 'orchestration.workerList',
      params: { includeRemote: true }
    })
    expect(unavailable).toMatchObject({
      ok: true,
      result: {
        partialHostErrors: [
          {
            environmentId: 'environment_windows',
            code: 'host_unavailable',
            dispatchIds: [firstDispatchId]
          }
        ]
      }
    })
    const unavailableWorker = (
      unavailable as { result: { workers: { dispatchId: string; projection: unknown }[] } }
    ).result.workers.find((worker) => worker.dispatchId === firstDispatchId)
    expect(unavailableWorker?.projection).toMatchObject({
      liveness: { verdict: 'unverifiable', reason: 'host_unavailable' }
    })
  })

  it('negotiates release on the execution host and never treats relay loss as exit', async () => {
    const dispatchId = await startSettledRemoteWorker()
    workerReleaseUnavailable = true
    const unavailable = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_unavailable',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_unavailable',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(unavailable).toMatchObject({
      ok: true,
      result: {
        state: 'release_unknown',
        processAction: 'none',
        recovery: expect.stringContaining('fresh request ID')
      }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()

    workerReleaseUnavailable = false
    const replayedUnknown = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_unavailable_replay',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_unavailable',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(replayedUnknown).toMatchObject({
      ok: true,
      result: { state: 'release_unknown', mutation: { replayed: true } }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()

    const released = await homeDispatcher.dispatch({
      id: 'rpc_remote_release',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_after_reconnect',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(released).toMatchObject({
      ok: true,
      result: {
        state: 'released',
        processAction: 'closed_agent_terminal',
        archive: { source: 'terminal', status: 'captured' },
        remoteOutput: {
          terminal: { tail: ['remote output'] },
          status: { terminal: 'exited', liveness: 'exited' }
        }
      }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledWith('term_windows_worker')

    // A confirmed remote release converges the home projection and is safe to
    // replay after a response/relay race.
    expect(homeDb.getWorkerDispatch(dispatchId)).toMatchObject({
      stage: 'released',
      agent_terminal_handle: null
    })
    const projected = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_projection',
      authToken: 'coordinator-token',
      method: 'orchestration.workerList',
      params: {}
    })
    const projectedWorker = (
      projected as { result: { workers: { dispatchId: string; projection: unknown }[] } }
    ).result.workers.find((worker) => worker.dispatchId === dispatchId)
    expect(projectedWorker?.projection).toMatchObject({
      liveness: { verdict: 'exited', source: 'execution_host' },
      nextAction: { kind: 'none', argv: [] }
    })
  })

  it('serves a durable redacted archive after remote terminal removal and host restart', async () => {
    const dispatchId = await startSettledRemoteWorker()
    const capability = `dcap_${'A'.repeat(43)}`
    vi.mocked(workerRuntime.readTerminal).mockResolvedValue({
      handle: 'term_windows_worker',
      status: 'running',
      tail: ['x'.repeat(300_000), `secret ${capability}`, 'remote output'],
      truncated: false,
      nextCursor: '3'
    })
    vi.mocked(workerRuntime.closeTerminal).mockImplementation(async () => {
      const archive = workerDb.getWorkerTerminalArchive(dispatchId)
      expect(archive).toBeDefined()
      expect(archive!.content.length).toBeLessThan(270_000)
      workerTerminalAvailable = false
      return { ptyKilled: true } as never
    })

    const released = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_archive',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_archive',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(released).toMatchObject({
      ok: true,
      result: { state: 'released', archive: { source: 'terminal', status: 'captured' } }
    })

    const afterRemoval = await homeDispatcher.dispatch({
      id: 'rpc_remote_read_archive_after_removal',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId }
    })
    expect(afterRemoval).toMatchObject({
      ok: true,
      result: {
        archived: true,
        terminal: {
          tail: ['secret [dispatch capability redacted]', 'remote output'],
          truncated: true
        }
      }
    })
    expect(JSON.stringify(afterRemoval)).not.toContain(capability)

    restartWorkerRuntime(true)
    const afterRestart = await homeDispatcher.dispatch({
      id: 'rpc_remote_read_archive_after_restart',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId }
    })
    expect(afterRestart).toMatchObject({
      ok: true,
      result: {
        archived: true,
        terminal: {
          tail: ['secret [dispatch capability redacted]', 'remote output'],
          truncated: true
        }
      }
    })

    const replayed = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_archive_replay',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_archive_replay',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(replayed).toMatchObject({
      ok: true,
      result: {
        state: 'already_released',
        processAction: 'none',
        archive: { source: 'terminal', status: 'captured' }
      }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  registerFederatedReleaseRecoveryScenarios({
    startSettledRemoteWorker,
    dispatch: (request) => homeDispatcher.dispatch(request),
    runtime: () => workerRuntime,
    homeDb: () => homeDb,
    workerDb: () => workerDb,
    setWorkerTerminalAvailable: (available) => {
      workerTerminalAvailable = available
    },
    restartWorkerRuntime
  })

  it('does not report a captured remote archive or close when persistence fails', async () => {
    const dispatchId = await startRemoteWorker()
    workerDb.db.exec('DROP TABLE worker_terminal_archives')

    const released = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_archive_failure',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_archive_failure',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(released).toMatchObject({
      ok: true,
      result: { state: 'retained', processAction: 'none', archive: null }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('keeps reads, fleet snapshots, and release on legacy fallbacks for an old peer', async () => {
    workerAdvertisesNewCapabilities = false
    // A shipped host that does not advertise structured read still has to be asked; only its
    // own method_not_found may downgrade the read to a terminal scrape.
    workerSupportsStructuredRead = false
    const dispatchId = await startRemoteWorker()
    remoteCalls = []
    const read = await homeDispatcher.dispatch({
      id: 'rpc_old_peer_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId }
    })
    const fleet = await homeDispatcher.dispatch({
      id: 'rpc_old_peer_fleet',
      authToken: 'coordinator-token',
      method: 'orchestration.workerList',
      params: { includeRemote: true }
    })
    const release = await homeDispatcher.dispatch({
      id: 'rpc_old_peer_release',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'old_peer_release',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(read).toMatchObject({
      ok: true,
      result: { fallbackReason: 'remote_capability_unavailable' }
    })
    expect(fleet).toMatchObject({
      ok: true,
      result: { partialHostErrors: [{ code: 'capability_unsupported' }] }
    })
    expect(release).toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'federation_unsupported' }
    })
    expect(remoteCalls).toContain('orchestration.federationReadOutput')
    expect(remoteCalls).toContain('orchestration.federationFleetSnapshot')
    expect(remoteCalls).not.toContain('orchestration.federationRelease')
  })

  it('retains a mixed-version worker when its host cannot guarantee a durable archive', async () => {
    workerAdvertisesDurableRelease = false
    const dispatchId = await startRemoteWorker()
    remoteCalls = []

    const release = await homeDispatcher.dispatch({
      id: 'rpc_nondurable_peer_release',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'nondurable_peer_release',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(release).toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'federation_unsupported', archive: null }
    })
    expect(remoteCalls).not.toContain('orchestration.federationRelease')
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('re-negotiates read, fleet, and release after an empty pull observes a restarted peer', async () => {
    workerAdvertisesNewCapabilities = false
    const dispatchId = await startSettledRemoteWorker()
    homeRuntime.stopOrchestrationFederationRelay()
    remoteCalls = []

    await homeDispatcher.dispatch({
      id: 'rpc_old_peer_cache_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId }
    })
    // The unadvertised capability never blocks the call; only method_not_found would.
    expect(remoteCalls).toContain('orchestration.federationReadOutput')

    const oldEpoch = homeDb.getFederatedDispatch(dispatchId)?.remote_runtime_epoch
    expect(oldEpoch).toBe(workerRuntime.getRuntimeId())
    workerAdvertisesNewCapabilities = true
    restartWorkerRuntime()
    remoteCalls = []
    await homeRuntime.syncOrchestrationFederatedDispatch(dispatchId)
    expect(remoteCalls.filter((method) => method === 'orchestration.federationPull')).toHaveLength(
      1
    )
    expect(remoteCalls).not.toContain('orchestration.federationAck')
    expect(remoteCalls).not.toContain('orchestration.federationImport')
    expect(homeDb.getFederatedDispatch(dispatchId)?.remote_runtime_epoch).not.toBe(oldEpoch)
    remoteCalls = []

    const read = await homeDispatcher.dispatch({
      id: 'rpc_restarted_peer_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId }
    })
    const fleet = await homeDispatcher.dispatch({
      id: 'rpc_restarted_peer_fleet',
      authToken: 'coordinator-token',
      method: 'orchestration.workerList',
      params: { includeRemote: true }
    })
    // Read and fleet negotiate through the methods themselves, so neither spends a probe.
    expect(remoteCalls.filter((method) => method === 'status.get')).toHaveLength(0)
    const release = await homeDispatcher.dispatch({
      id: 'rpc_restarted_peer_release',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'restarted_peer_release',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(read).toMatchObject({ ok: true, result: { source: 'terminal' } })
    expect(fleet).toMatchObject({ ok: true })
    expect(release).toMatchObject({ ok: true, result: { state: 'released' } })
    // Only release still probes: its capability asserts a durable archive, not method existence.
    expect(remoteCalls).toContain('orchestration.federationReadOutput')
    expect(remoteCalls).toContain('orchestration.federationFleetSnapshot')
    expect(remoteCalls).toContain('orchestration.federationRelease')
  })
})
