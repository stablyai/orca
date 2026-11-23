import type { OrcaRuntimeService } from '../orca-runtime'
import { getStoreGitHubParticipantJobs } from '../github-participant-jobs'
import { resolveGitHubParticipantJobProof } from '../github-participant-job-proof'
import {
  runWithGitHubExecutionIdentity,
  runWithGitHubJobRequest
} from '../github-participant-execution'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { RpcCallerIdentity } from './callers/rpc-caller-identity'
import type { RpcContext, RpcRequest } from './core'
import { runWithActiveRpcCaller } from './callers/active-call'

export function runWithGitHubParticipantCall<T>(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  context: Pick<RpcContext, 'caller' | 'deviceSelf'>,
  run: () => T
): Promise<Awaited<T>> {
  return runWithActiveRpcCaller(
    context.caller,
    () => runWithGitHubParticipantJobContext(runtime, request, context.caller, run),
    request.orchestrationCompatibilityEvidence?.agentSessionId,
    context.deviceSelf?.clientInstanceId()
  )
}

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
  await registry?.ready()
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
