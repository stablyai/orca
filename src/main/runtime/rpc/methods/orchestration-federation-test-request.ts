import { vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import type { OrchestrationCompatibilityEvidence } from '../../../../shared/orchestration-compatibility-evidence'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'

export const FEDERATION_COORDINATOR_EVIDENCE = {
  terminalHandle: 'term_coord',
  paneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  launchToken: 'coordinator-launch-token'
} as const satisfies OrchestrationCompatibilityEvidence

export function mockFederationCoordinatorAttestation(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === FEDERATION_COORDINATOR_EVIDENCE.terminalHandle
      ? FEDERATION_COORDINATOR_EVIDENCE.paneKey
      : null
  )
  vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) =>
    evidence?.terminalHandle === FEDERATION_COORDINATOR_EVIDENCE.terminalHandle &&
    evidence.paneKey === FEDERATION_COORDINATOR_EVIDENCE.paneKey
      ? {
          terminalHandle: evidence.terminalHandle,
          paneKey: evidence.paneKey,
          processIncarnation: 'home_runtime:coordinator:1',
          hostScope: { kind: 'local', hostId: 'local' },
          launchTokenHash: 'test-token-hash',
          terminalProvenance: 'current_runtime'
        }
      : null
  )
}

export function createFederationWorkerStartRequest(
  taskId: string,
  overrides: Record<string, unknown> = {}
): RpcRequest {
  return {
    id: 'rpc_worker_start',
    authToken: 'coordinator-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: 'request_windows_worker',
    orchestrationCompatibilityEvidence: FEDERATION_COORDINATOR_EVIDENCE,
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
