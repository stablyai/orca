import type { OrcaRuntimeService } from '../orca-runtime'
import { getStoreGitHubParticipantJobs } from '../github-participant-jobs'
import { resolveGitHubParticipantJobProof } from '../github-participant-job-proof'
import {
  runWithGitHubExecutionIdentity,
  runWithGitHubJobRequest
} from '../github-participant-execution'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RpcCallerIdentity } from './rpc-caller-identity'
import type { RpcRequest } from './core'

export async function runWithGitHubParticipantJobContext<T>(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  caller: RpcCallerIdentity | undefined,
  run: () => T
): Promise<Awaited<T>> {
  const evidence = request.orchestrationCompatibilityEvidence
  const isJob =
    caller?.kind === 'local-cli' && Boolean(evidence?.agentSessionId || evidence?.launchToken)
  return await runWithGitHubJobRequest(isJob, () =>
    resolveJobContext(runtime, request, caller, run)
  )
}

async function resolveJobContext<T>(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  caller: RpcCallerIdentity | undefined,
  run: () => T
): Promise<Awaited<T>> {
  const registry = runtime.getGitHubParticipantRegistry?.()
  if (
    caller?.kind !== 'local-cli' ||
    !request.orchestrationCompatibilityEvidence ||
    !registry?.hasEnabledRepos()
  ) {
    return await run()
  }
  const jobs = getStoreGitHubParticipantJobs(runtime.requireStore())
  if (!jobs) {
    return await run()
  }
  const identity = await resolveGitHubParticipantJobProof(
    {
      registry,
      jobs,
      readSession: async (id) => {
        await runtime.ensureStructuredAgentSessionHost()
        return getStructuredAgentSessionHost()?.deps.store.getRecord(id) ?? null
      },
      verifyTerminal: (evidence) => {
        const proof = runtime.verifyOrchestrationCompatibilityCaller(evidence, {
          currentRuntimeLaunchSufficient: true
        })
        if (!proof || proof.hostScope.kind !== 'local') {
          return null
        }
        const terminal = runtime.getOrchestrationDispatchAuthority(proof.terminalHandle)
        return terminal?.paneKey === proof.paneKey
          ? { paneKey: proof.paneKey, workspaceId: terminal.worktreeId }
          : null
      }
    },
    caller,
    request.orchestrationCompatibilityEvidence
  )
  return await runWithGitHubExecutionIdentity(identity, run)
}
