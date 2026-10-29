import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeStore } from './runtime-store-contract'
import { getStoreGitHubParticipants } from './github-participant-store'
import { getStoreGitHubParticipantJobs } from './github-participant-jobs'
import { captureGitHubExecutionIdentity } from './github-participant-execution'

export function bindParticipantLaunch(
  store: RuntimeStore | null,
  workspace: Pick<TerminalWorkspaceLaunchScope, 'repo' | 'id'>,
  paneKey: string,
  launchToken: string | undefined
): void {
  if (!launchToken || !store || !workspace.repo) {
    return
  }
  const identity = captureGitHubExecutionIdentity(
    getStoreGitHubParticipants(store),
    workspace.repo.id
  )
  if (!identity) {
    return
  }
  const jobs = getStoreGitHubParticipantJobs(store)
  if (!jobs) {
    throw new Error('github_participant_jobs_unavailable')
  }
  jobs.bindTerminal(paneKey, workspace.id, launchToken, identity)
}

export function bindGitHubParticipantSession(
  store: RuntimeStore,
  repoId: string,
  workspaceId: string,
  sessionId: string,
  priorRecord: boolean
): void {
  const registry = getStoreGitHubParticipants(store)
  const identity = captureGitHubExecutionIdentity(registry, repoId)
  if (!identity) {
    return
  }
  const jobs = getStoreGitHubParticipantJobs(store)
  if (!jobs) {
    throw new Error('github_participant_jobs_unavailable')
  }
  if (priorRecord && !jobs.session(sessionId, workspaceId)) {
    return
  }
  const bound = jobs.bindSession(sessionId, workspaceId, identity)
  registry?.resolveParticipantAccount(bound.repoId, bound.participantId, bound.account)
}
