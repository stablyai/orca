import { ipcMain, type IpcMainInvokeEvent } from 'electron'
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
import {
  cancelPRDetailRecovery,
  cancelPRDetailRecoveryCaller,
  commitPRDetailRecovery,
  startPRDetailRecovery,
  waitPRDetailRecovery
} from '../../github/pull-requests/refresh/pr-detail-recovery-coordinator'
import { validateAutomaticPRRefreshCandidate } from './github-repo-routing'
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
): GitHubPRRefreshCandidate | 'validation' {
  const candidate = prDetailRecoveryCandidate(args)
  if (!candidate) {
    return 'validation'
  }
  const validation = validateAutomaticPRRefreshCandidate(candidate, store)
  return validation.kind === 'ok' ? validation.candidate : 'validation'
}

/** Native detail recovery: the same coordinator ticket the runtime methods use, leased to this window. */
export function registerGitHubPRDetailRecoveryHandlers(store: Store): void {
  ipcMain.handle(
    'gh:startPRDetailRecovery',
    (event, args: PRDetailRecoveryStartArgs): PRDetailRecoverySnapshot => {
      const key = callerKey(event)
      return startPRDetailRecovery(
        { callerKey: key, windowId: event.sender.id },
        args,
        resolveCandidate(store, args)
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
