import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import type {
  PRDetailRecoveryCancelArgs,
  PRDetailRecoveryCommitArgs,
  PRDetailRecoverySnapshot,
  PRDetailRecoveryStartArgs,
  PRDetailRecoveryWaitArgs
} from '../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { Store } from '../../persistence/loading-store/store'
import { prDetailRecoveryCandidate } from '../../github/pull-requests/refresh/pr-detail-recovery-candidate'
import { bindRepoExecutionHost } from '../../workspaces/execution-host/repo-execution-host'
import {
  cancelPRDetailRecovery,
  cancelPRDetailRecoveryCaller,
  commitPRDetailRecovery,
  startPRDetailRecovery,
  waitPRDetailRecovery
} from '../../github/pull-requests/refresh/pr-detail-recovery-coordinator'
import {
  applyRegisteredRepoToPRRefreshCandidate,
  assertRegisteredGitHubRepo
} from './github-repo-routing'
import { prRefreshRequestDigest } from '../../github/pull-requests/refresh/pr-refresh-request-registry'
import { abortWhenRendererGone } from '../renderer-lifetime-abort'

const leasedSenders = new Set<number>()

function callerKey(event: IpcMainInvokeEvent): string {
  const senderId = event.sender.id
  if (!leasedSenders.has(senderId)) {
    leasedSenders.add(senderId)
    // A closed or reloaded window cannot observe its tickets; release them with it.
    abortWhenRendererGone(event.sender).signal.addEventListener(
      'abort',
      () => {
        leasedSenders.delete(senderId)
        cancelPRDetailRecoveryCaller(`ipc:${senderId}`)
      },
      { once: true }
    )
  }
  return `ipc:${senderId}`
}

function resolveCandidate(
  store: Store,
  args: PRDetailRecoveryStartArgs
): { candidate: GitHubPRRefreshCandidate; ownerDigest: string } | 'validation' {
  const candidate = prDetailRecoveryCandidate(args)
  const executionHostId = normalizeExecutionHostId(args.identity.executionHostId)
  if (!candidate || !executionHostId) {
    return 'validation'
  }
  try {
    const repo = assertRegisteredGitHubRepo(
      {
        repoId: candidate.repoId,
        repoPath: candidate.repoPath,
        repoOwnerExecutionHostId: executionHostId
      },
      store
    )
    const owner = bindRepoExecutionHost(repo, 'native')
    if ((repo.kind ?? 'git') !== 'git' || !owner || owner.executionHostId !== executionHostId) {
      return 'validation'
    }
    const boundCandidate: GitHubPRRefreshCandidate = {
      ...applyRegisteredRepoToPRRefreshCandidate(store, repo, candidate),
      ...owner,
      connectionState: owner.connectionId ? 'connected' : 'unknown'
    }
    return {
      candidate: boundCandidate,
      ownerDigest: JSON.stringify([
        prRefreshRequestDigest(boundCandidate),
        repo.ghAccount?.host ?? null,
        repo.ghAccount?.user ?? null
      ])
    }
  } catch {
    return 'validation'
  }
}

/** Native detail recovery: the same coordinator ticket the runtime methods use, leased to this window. */
export function registerGitHubPRDetailRecoveryHandlers(store: Store): void {
  ipcMain.handle(
    'gh:startPRDetailRecovery',
    (event, args: PRDetailRecoveryStartArgs): PRDetailRecoverySnapshot => {
      const key = callerKey(event)
      const selected = resolveCandidate(store, args)
      const ownerDigest = selected === 'validation' ? null : selected.ownerDigest
      return startPRDetailRecovery(
        {
          callerKey: key,
          windowId: event.sender.id,
          isOwnerCurrent: () => {
            const current = resolveCandidate(store, args)
            return current !== 'validation' && current.ownerDigest === ownerDigest
          }
        },
        args,
        selected === 'validation' ? 'validation' : selected.candidate
      )
    }
  )
  ipcMain.handle('gh:waitPRDetailRecovery', (event, args: PRDetailRecoveryWaitArgs) =>
    waitPRDetailRecovery(callerKey(event), args.ticketId, args.afterRevision)
  )
  ipcMain.handle('gh:commitPRDetailRecovery', (event, args: PRDetailRecoveryCommitArgs) =>
    commitPRDetailRecovery(callerKey(event), args)
  )
  ipcMain.handle('gh:cancelPRDetailRecovery', (event, args: PRDetailRecoveryCancelArgs) =>
    cancelPRDetailRecovery(callerKey(event), args.ticketId)
  )
}
