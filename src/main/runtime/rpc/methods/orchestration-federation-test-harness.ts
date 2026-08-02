import { afterEach, beforeEach, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'

export let homeDb: OrchestrationDb
export let workerDb: OrchestrationDb
export let homeRuntime: OrcaRuntimeService
export let workerRuntime: OrcaRuntimeService
export let homeDispatcher: RpcDispatcher
export let workerDispatcher: RpcDispatcher
export let workerCapabilities: string[]
export let workerPeerFingerprint: string
export let loseNextAckResponse: boolean

const databases: OrchestrationDb[] = []

export function setupFederationTestHarness(): void {
  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    databases.push(homeDb, workerDb)
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
    workerPeerFingerprint = 'windows_peer_fingerprint'
    loseNextAckResponse = false
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: workerPeerFingerprint
      }),
      call: async (_selector, method, params, _timeoutMs, envelope) => {
        if (method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: { ...workerRuntime.getStatus(), capabilities: workerCapabilities },
            _meta: { runtimeId: workerRuntime.getRuntimeId() }
          }
        }
        const response = (await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          orchestrationCapability: envelope?.orchestrationCapability
        })) as RuntimeRpcResponse<unknown>
        if (method === 'orchestration.federationAck' && loseNextAckResponse) {
          loseNextAckResponse = false
          throw new Error('connection lost after acknowledgment')
        }
        return response
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
  })
}

export function createHomeTask() {
  const run = homeDb.createRun({
    objective: 'Mac to Windows',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  return homeDb.createTask({ spec: 'Audit Windows behavior', runId: run.id })
}

export function startRequest(taskId: string, overrides: Record<string, unknown> = {}): RpcRequest {
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
      name: 'windows-audit',
      agent: 'codex',
      ...overrides
    }
  }
}

export function configureWorkerRuntime(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'windows-repo', kind: 'git' } as never)
  vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
    worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
    startupTerminal: { spawned: true, handle: 'term_windows_worker' },
    setupReceipt: {
      requested: 'run',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'running'
    }
  } as never)
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
    terminals: [
      { handle: 'term_windows_worker', title: 'Codex' },
      { handle: 'term_windows_setup', title: 'Setup' }
    ],
    totalCount: 2,
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
  vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
    handle: 'term_windows_worker',
    worktreeId: 'repo::windows-worktree',
    status: 'running'
  } as never)
  vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
    handle: 'term_windows_worker',
    status: 'running',
    entries: [{ cursor: 1, text: 'remote output' }],
    nextCursor: '1',
    limited: false
  } as never)
  vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
    handle: 'term_windows_worker',
    closed: true
  } as never)
}

export function restartWorkerRuntime(): void {
  workerRuntime = new OrcaRuntimeService()
  workerRuntime.setOrchestrationDb(workerDb)
  configureWorkerRuntime(workerRuntime)
  workerDispatcher = new RpcDispatcher({
    runtime: workerRuntime,
    methods: ORCHESTRATION_METHODS
  })
  workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
}

export function setWorkerPeerFingerprint(fingerprint: string): void {
  workerPeerFingerprint = fingerprint
}

export { ORCHESTRATION_CONTRACT_VERSION, ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY }
