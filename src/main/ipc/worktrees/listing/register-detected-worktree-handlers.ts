import { ipcMain } from 'electron'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'
import type {
  HostQualifiedDetectedWorktreeResult,
  DirectSshDetectedWorktreeRequest,
  ProviderRequestId
} from '../../../../shared/detected-worktree-provider-contract'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  registerSshProviderRequestAbort,
  getSshProviderAuthority,
  isCurrentSshProviderAuthority
} from '../../../ssh/ssh-provider-authority'
import { getSshGitProvider } from '../../../providers/ssh-git-dispatch'
import type { DetectedWorktreeRequestArgs } from '../ipc-context-schemas'
import {
  hasValidDirectSshAuthority,
  listDetectedWorktreesForCapturedRepo
} from './detected-provider-listing'
import { listHostQualifiedDetectedWorktrees } from './host-qualified-worktree-listing'
import { findExactRepoOwner, isCapturedRepoCurrent } from './worktree-host-ownership'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

export const DETECTED_WORKTREE_PROVIDER_TIMEOUT_MS = 30_000

export function registerDetectedWorktreeHandlers(context: WorktreeIpcContext): void {
  const { store, detectedWorktreeCancellations } = context

  ipcMain.handle(
    'worktrees:listDetected',
    async (
      event,
      args: DetectedWorktreeRequestArgs
    ): Promise<DetectedWorktreeListResult | HostQualifiedDetectedWorktreeResult> => {
      if ('executionHostId' in args) {
        const parsedHost = parseExecutionHostId(args.executionHostId)
        const directSshRequest = parsedHost?.kind === 'ssh'
        const controller = directSshRequest
          ? detectedWorktreeCancellations.begin(event, args.providerRequestId)
          : null
        const directArgs = args as DirectSshDetectedWorktreeRequest
        const removeAuthorityAbort =
          controller &&
          parsedHost?.kind === 'ssh' &&
          hasValidDirectSshAuthority(directArgs) &&
          directArgs.expectedAuthority.targetId === parsedHost.targetId
            ? registerSshProviderRequestAbort(directArgs.expectedAuthority, controller)
            : undefined
        let timedOut = false
        let removeAbortListener: (() => void) | undefined
        const abortedResult = controller
          ? new Promise<HostQualifiedDetectedWorktreeResult>((resolve) => {
              const onAbort = (): void => {
                resolve({
                  providerRequestId: args.providerRequestId,
                  executionHostId: args.executionHostId,
                  status: timedOut ? 'timed-out' : 'canceled'
                })
              }
              controller.signal.addEventListener('abort', onAbort, { once: true })
              removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort)
            })
          : undefined
        const timeout = controller
          ? setTimeout(() => {
              timedOut = true
              controller.abort()
            }, DETECTED_WORKTREE_PROVIDER_TIMEOUT_MS)
          : undefined
        try {
          const providerResult = listHostQualifiedDetectedWorktrees(
            store,
            args,
            controller
              ? {
                  signal: controller.signal,
                  status: () => (timedOut ? 'timed-out' : 'canceled')
                }
              : undefined
          )
          return abortedResult
            ? await Promise.race([providerResult, abortedResult])
            : await providerResult
        } finally {
          if (timeout) {
            clearTimeout(timeout)
          }
          removeAbortListener?.()
          removeAuthorityAbort?.()
          detectedWorktreeCancellations.finish(event, args.providerRequestId, controller)
        }
      }
      const repo = findExactRepoOwner(store, args.repoId)
      if (!repo) {
        return {
          repoId: args.repoId,
          authoritative: false,
          source: 'metadata-fallback',
          worktrees: []
        }
      }
      const provider = repo.connectionId ? getSshGitProvider(repo.connectionId) : undefined
      const authority = repo.connectionId
        ? { ...getSshProviderAuthority(repo.connectionId) }
        : undefined
      const result = await listDetectedWorktreesForCapturedRepo(
        store,
        repo,
        () =>
          isCapturedRepoCurrent(store, repo) &&
          (!repo.connectionId ||
            (getSshGitProvider(repo.connectionId) === provider &&
              authority !== undefined &&
              isCurrentSshProviderAuthority(authority))),
        provider
      )
      return result && !('providerAbortStatus' in result)
        ? result
        : {
            repoId: repo.id,
            authoritative: false,
            source: 'metadata-fallback',
            worktrees: []
          }
    }
  )

  ipcMain.handle(
    'worktrees:cancelListDetected',
    (event, args: { providerRequestId: ProviderRequestId }): void => {
      detectedWorktreeCancellations.cancel(event, args.providerRequestId)
    }
  )
}
