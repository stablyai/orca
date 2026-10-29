import { createHash, timingSafeEqual } from 'node:crypto'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { GitHubExecutionIdentity } from '../../shared/github/execution-identity'
import type { GitHubParticipantJobs } from './github-participant-jobs'
import type { GitHubParticipantRegistry } from './github-participant-registry'
import type { RpcCallerIdentity } from './rpc/rpc-caller-identity'

type ProofDeps = {
  registry: GitHubParticipantRegistry
  jobs: GitHubParticipantJobs
  readSession: (id: string) => Promise<AgentSessionRecord | null>
  verifyTerminal: (
    evidence: OrchestrationCompatibilityEvidence
  ) => { paneKey: string; workspaceId: string } | null
}
const digest = (token: string) => createHash('sha256').update(token).digest()

export async function resolveGitHubParticipantJobProof(
  deps: ProofDeps,
  caller: RpcCallerIdentity | undefined,
  evidence: OrchestrationCompatibilityEvidence | undefined
): Promise<GitHubExecutionIdentity | undefined> {
  if (caller?.kind !== 'local-cli' || !evidence) {
    return undefined
  }
  let identity: GitHubExecutionIdentity | undefined
  if (evidence.agentSessionId) {
    if (!evidence.agentSessionSpawnToken) {
      return undefined
    }
    const record = await deps.readSession(evidence.agentSessionId)
    const token = record?.lease.ownerProcess?.spawnToken
    if (
      !record ||
      record.sessionId !== evidence.agentSessionId ||
      evidence.host ||
      record.location.executionHostId !== 'local' ||
      record.location.wslDistro ||
      !agentSessionLeaseAdmitsWriter(record.lease) ||
      !token ||
      !timingSafeEqual(digest(token), digest(evidence.agentSessionSpawnToken))
    ) {
      throw new Error('github_participant_job_proof_invalid')
    }
    identity = deps.jobs.session(record.sessionId, record.location.workspaceId)
  } else if (evidence.launchToken) {
    const terminal = deps.verifyTerminal(evidence)
    if (!terminal) {
      throw new Error('github_participant_job_proof_invalid')
    }
    identity = deps.jobs.terminal(terminal.paneKey, terminal.workspaceId, evidence.launchToken)
  }
  if (!identity) {
    return undefined
  }
  const validated = deps.registry.resolveParticipantAccount(
    identity.repoId,
    identity.participantId,
    identity.account
  )
  return Object.freeze({ repoId: identity.repoId, ...validated })
}
