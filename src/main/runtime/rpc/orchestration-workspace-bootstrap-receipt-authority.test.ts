import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  RUNTIME_CAPABILITIES,
  WORKSPACE_BOOTSTRAP_GIT_HOME_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'

const COORDINATOR_HANDLE = 'term_current_coord'
const COORDINATOR_PANE = 'tab_current:55555555-5555-4555-8555-555555555555'
const LAUNCH_TOKEN = 'current-coordinator-token'
const LAUNCH_TOKEN_HASH = createHash('sha256').update(LAUNCH_TOKEN).digest('hex')

const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

function bootstrapRequest(
  runId: string,
  invocationId: string,
  evidence?: OrchestrationCompatibilityEvidence
): RpcRequest {
  return {
    id: `rpc_${invocationId}`,
    authToken: 'caller-token',
    method: 'orchestration.workspaceBootstrapReceipt',
    params: {
      runId,
      orchestrationHomeSelector: 'id:repo-1::worktree-1',
      executionWorkspaceSelector: 'id:repo-1::worktree-1',
      executionHostId: 'local'
    },
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: invocationId,
    compatibilityInvocationId: invocationId,
    ...(evidence ? { orchestrationCompatibilityEvidence: evidence } : {})
  }
}

describe('workspace bootstrap receipt current authority', () => {
  it('attests a fresh current coordinator and rejects stale or missing evidence', async () => {
    const database = new OrchestrationDb(':memory:')
    databases.push(database)
    expect(database.getLegacyAdoption()).toBeUndefined()
    const run = database.createRun({
      objective: 'Fresh workspace bootstrap',
      coordinatorHandle: COORDINATOR_HANDLE,
      coordinatorPaneKey: COORDINATOR_PANE
    })
    const runtime = new OrcaRuntimeService(null, undefined, {
      attestAgentHookCompatibilityAuthority: ({ paneKey, launchTokenHash, connectionId }) =>
        paneKey === COORDINATOR_PANE &&
        launchTokenHash === LAUNCH_TOKEN_HASH &&
        connectionId === null
          ? { paneKey, source: 'current_hook' }
          : null
    })
    runtime.setOrchestrationDb(database)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === COORDINATOR_HANDLE
        ? {
            runtimeId: 'runtime-current',
            terminalHandle: COORDINATOR_HANDLE,
            ptyId: 'pty-current',
            worktreeId: 'repo-1::worktree-1',
            processIncarnation: 'process-1',
            paneKey: COORDINATOR_PANE,
            launchTokenHash: LAUNCH_TOKEN_HASH,
            hostScope: { kind: 'local', hostId: 'local' }
          }
        : null
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo-1::worktree-1',
      repoId: 'repo-1',
      path: '/repo/worktree-1',
      hostId: 'local'
    } as never)
    const status = vi.spyOn(runtime, 'getRuntimeGitStatus').mockResolvedValue({
      head: 'a'.repeat(40),
      entries: []
    } as never)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const evidence = {
      terminalHandle: COORDINATOR_HANDLE,
      paneKey: COORDINATOR_PANE,
      launchToken: LAUNCH_TOKEN
    }

    const current = await dispatcher.dispatch(
      bootstrapRequest(run.id, 'current-bootstrap-receipt', evidence)
    )
    const stale = await dispatcher.dispatch(
      bootstrapRequest(run.id, 'stale-bootstrap-receipt', {
        ...evidence,
        launchToken: 'stale-token'
      })
    )
    const unauthenticated = await dispatcher.dispatch(
      bootstrapRequest(run.id, 'unauthenticated-bootstrap-receipt')
    )
    const oldClient = await dispatcher.dispatch(
      bootstrapRequest(run.id, 'old-client-bootstrap-receipt', evidence),
      {
        clientCapabilities: RUNTIME_CAPABILITIES.filter(
          (capability) => capability !== WORKSPACE_BOOTSTRAP_GIT_HOME_RUNTIME_CAPABILITY
        )
      }
    )

    expect(current).toMatchObject({
      ok: true,
      result: {
        authority: { kind: 'orca', issued_for_run_id: run.id },
        orchestration_home: { workspace_key: 'worktree:repo-1::worktree-1' }
      }
    })
    const authorizationFailure = {
      ok: false,
      error: {
        message: 'Workspace bootstrap receipts require an authenticated coordinator.'
      }
    }
    expect(stale).toMatchObject(authorizationFailure)
    expect(unauthenticated).toMatchObject(authorizationFailure)
    expect(oldClient).toMatchObject({ ok: false, error: { code: 'update_required' } })
    expect(status).toHaveBeenCalledTimes(2)
  })
})
