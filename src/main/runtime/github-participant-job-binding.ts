import type { TerminalWorkspaceLaunchScope } from './orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeStore } from './construction/runtime-store-contract'
import { getStoreGitHubParticipants } from './github-participant-store'
import { getStoreGitHubParticipantJobs } from './github-participant-jobs'
import { captureGitHubExecutionIdentity } from './github-participant-execution'

export async function bindParticipantLaunch(
  store: RuntimeStore | null,
  workspace: Pick<TerminalWorkspaceLaunchScope, 'repo' | 'id'>,
  paneKey: string,
  launchToken: string | undefined
): Promise<void> {
  if (!launchToken || !store || !workspace.repo) {
    return
  }
  const registry = getStoreGitHubParticipants(store)
  await registry?.ready()
  const identity = captureGitHubExecutionIdentity(registry, workspace.repo.id)
  if (!identity) {
    return
  }
  const jobs = getStoreGitHubParticipantJobs(store)
  if (!jobs) {
    throw new Error('github_participant_jobs_unavailable')
  }
  await jobs.bindTerminal(paneKey, workspace.id, launchToken, identity)
}

export async function bindGitHubParticipantSession(
  store: RuntimeStore,
  repoId: string,
  workspaceId: string,
  sessionId: string,
  priorRecord: boolean
): Promise<void> {
  const registry = getStoreGitHubParticipants(store)
  await registry?.ready()
  const identity = captureGitHubExecutionIdentity(registry, repoId)
  if (!identity) {
    return
  }
  const jobs = getStoreGitHubParticipantJobs(store)
  if (!jobs) {
    throw new Error('github_participant_jobs_unavailable')
  }
  await jobs.ready()
  if (priorRecord && !jobs.session(sessionId, workspaceId)) {
    return
  }
  const bound = await jobs.bindSession(sessionId, workspaceId, identity)
  registry?.resolveParticipantAccount(bound.repoId, bound.participantId, bound.account)
}
