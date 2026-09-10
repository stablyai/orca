import { vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { createManagedCliContext } from '../../../../shared/managed-cli-context'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'

/**
 * One home peer and one worker peer joined by a transport that can drop a single ack or
 * start reply. The object owns every mutable peer field, so a restart or a capability
 * change is visible to the relay closure instead of stranding it on a stale reference.
 */
export type FederationPeers = ReturnType<typeof createFederationPeers>

export function createFederationPeers() {
  const databases: OrchestrationDb[] = []
  const peers = {
    databases,
    homeDb: undefined as unknown as OrchestrationDb,
    workerDb: undefined as unknown as OrchestrationDb,
    homeRuntime: undefined as unknown as OrcaRuntimeService,
    workerRuntime: undefined as unknown as OrcaRuntimeService,
    homeDispatcher: undefined as unknown as RpcDispatcher,
    workerDispatcher: undefined as unknown as RpcDispatcher,
    workerCapabilities: [] as string[],
    workerPeerFingerprint: '',
    loseNextAckResponse: false,
    loseNextStartResponse: false,
    createHomeTask() {
      const run = peers.homeDb.createRun({
        objective: 'Mac to Windows',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      return peers.homeDb.createTask({ spec: 'Audit Windows behavior', runId: run.id })
    },
    configureWorkerRuntime(runtime: OrcaRuntimeService): void {
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
      vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
        status: 'live',
        ptyIds: ['pty-windows-worker']
      })
      vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue({
        paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        processIncarnation: 'windows_runtime:pty:1',
        connectionId: null,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'windows-lead-session' },
        observedAt: Date.now(),
        statusObservedAt: Date.now(),
        subagents: [],
        actorAttestation: {
          authorityId: 'agent-hook-main:test',
          incarnation: 1,
          revision: 1,
          observedAt: Date.now(),
          provider: 'codex',
          role: 'lead',
          eventName: 'PreToolUse',
          providerSessionId: 'windows-lead-session'
        }
      } as never)
      vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
      vi.spyOn(runtime, 'preflightWorktreeManagedCliExecutable').mockReturnValue('orca')
      vi.spyOn(runtime, 'assertTerminalManagedCliAvailable').mockImplementation(() => {})
      vi.spyOn(runtime, 'buildTerminalManagedCliContext').mockImplementation((handle) =>
        createManagedCliContext({
          executable: 'orca',
          runtimeId: runtime.getRuntimeId(),
          executionHostId: 'local',
          workspaceKey: 'worktree:repo::windows-worktree',
          terminalHandle: handle
        })
      )
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
        tail: ['remote output'],
        truncated: false,
        entries: [{ cursor: 1, text: 'remote output' }],
        nextCursor: '1',
        limited: false
      } as never)
      vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
        handle: 'term_windows_worker',
        tabId: 'tab-windows-worker',
        ptyKilled: true
      } as never)
    },
    restartWorkerRuntime(): void {
      peers.workerRuntime = new OrcaRuntimeService()
      peers.workerRuntime.setOrchestrationDb(peers.workerDb)
      peers.configureWorkerRuntime(peers.workerRuntime)
      peers.workerDispatcher = new RpcDispatcher({
        runtime: peers.workerRuntime,
        methods: ORCHESTRATION_METHODS
      })
      peers.workerCapabilities = [...(peers.workerRuntime.getStatus().capabilities ?? [])]
    },
    close(): void {
      peers.homeRuntime.stopOrchestrationFederationRelay()
      for (const db of databases.splice(0)) {
        db.close()
      }
    }
  }
  peers.homeDb = new OrchestrationDb(':memory:')
  peers.workerDb = new OrchestrationDb(':memory:')
  databases.push(peers.homeDb, peers.workerDb)
  peers.workerRuntime = new OrcaRuntimeService()
  peers.workerRuntime.setOrchestrationDb(peers.workerDb)
  peers.workerDispatcher = new RpcDispatcher({
    runtime: peers.workerRuntime,
    methods: ORCHESTRATION_METHODS
  })
  peers.workerCapabilities = [...(peers.workerRuntime.getStatus().capabilities ?? [])]
  peers.workerPeerFingerprint = 'windows_peer_fingerprint'
  peers.loseNextAckResponse = false
  peers.loseNextStartResponse = false
  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => ({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: peers.workerPeerFingerprint
    }),
    call: async (_selector, method, params, _timeoutMs, envelope) => {
      if (method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: { ...peers.workerRuntime.getStatus(), capabilities: peers.workerCapabilities },
          _meta: { runtimeId: peers.workerRuntime.getRuntimeId() }
        }
      }
      const response = (await peers.workerDispatcher.dispatch({
        id: `remote_${method}`,
        authToken: 'run-home-device-token',
        method,
        params,
        orchestrationContractVersion: envelope?.orchestrationContractVersion,
        orchestrationRequestId: envelope?.orchestrationRequestId,
        orchestrationCapability: envelope?.orchestrationCapability
      })) as RuntimeRpcResponse<unknown>
      if (method === 'orchestration.federationAttachStart' && peers.loseNextStartResponse) {
        peers.loseNextStartResponse = false
        throw new Error('connection lost after worker start')
      }
      if (method === 'orchestration.federationAck' && peers.loseNextAckResponse) {
        peers.loseNextAckResponse = false
        throw new Error('connection lost after acknowledgment')
      }
      return response
    }
  }
  peers.homeRuntime = new OrcaRuntimeService(null, undefined, {
    orchestrationEnvironmentTransport: transport
  })
  peers.homeRuntime.setOrchestrationDb(peers.homeDb)
  peers.homeDispatcher = new RpcDispatcher({
    runtime: peers.homeRuntime,
    methods: ORCHESTRATION_METHODS
  })
  vi.spyOn(peers.homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_coord' ? 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null
  )
  peers.configureWorkerRuntime(peers.workerRuntime)
  return peers
}
