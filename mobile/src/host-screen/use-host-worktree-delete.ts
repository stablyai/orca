import { useCallback, useState } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import {
  ARCHIVE_HOOK_FAILED_REMOVAL_CODE,
  worktreeRemovalReplyTimeoutMs
} from '../../../src/shared/worktree/archive-hook-removal-gate'
import type { OrcaHookTrustPrompt } from '../components/OrcaHookTrustDrawer'
import { newWorkspaceUiStateRead } from '../components/new-workspace-operations'
import {
  isOrcaHookTrusted,
  persistOrcaHookTrustApproval,
  wasOrcaHookPreviouslyApproved
} from '../tasks/setup-hook-trust'
import type { RpcClient } from '../transport/rpc-client'
import { removeWorktreeRow } from '../worktree/worktree-host-row-identity'
import type { Worktree } from '../worktree/workspace-list-sections'
import { worktreeArchiveHookTrustRead, worktreeRemove } from './host-screen-operations'
import type { HostScreenState } from './use-host-screen-state'

type ArchiveHookDecision =
  | { kind: 'run' | 'skip' }
  | { kind: 'ask'; prompt: OrcaHookTrustPrompt; trust: PersistedTrustedOrcaHooks }

export type ArchiveHookTrustRequest = {
  item: Worktree
  prompt: OrcaHookTrustPrompt
  trust: PersistedTrustedOrcaHooks
}

export type ArchiveHookFailure = { item: Worktree; message: string }

// Desktop's ensureHooksConfirmed('archive'): a script that cannot be inspected or checked against trust does not run.
async function decideArchiveHookRun(args: {
  rowClient: RpcClient
  desktopClient: RpcClient
  repos: readonly { id: string }[]
  item: Worktree
}): Promise<ArchiveHookDecision> {
  const { repoId } = args.item
  try {
    const hooks = worktreeArchiveHookTrustRead.interpret(
      await worktreeArchiveHookTrustRead.request(args.rowClient, { repo: `id:${repoId}` })
    )
    if (!hooks.accepted || hooks.value === undefined) {
      return { kind: 'skip' }
    }
    const archiveTrust = hooks.value
    if (archiveTrust === null) {
      return { kind: 'run' }
    }
    // Trust lives on the paired desktop, whichever host owns the workspace.
    const ui = newWorkspaceUiStateRead.interpret(
      await newWorkspaceUiStateRead.request(args.desktopClient)
    )
    if (!ui.accepted) {
      return { kind: 'skip' }
    }
    const trust = ui.value?.trustedOrcaHooks ?? {}
    if (isOrcaHookTrusted(trust, args.repos, repoId, 'archive', archiveTrust.contentHash)) {
      return { kind: 'run' }
    }
    return {
      kind: 'ask',
      trust,
      prompt: {
        kind: 'archive',
        repoId,
        repoName: args.item.repo,
        scriptContent: archiveTrust.scriptContent,
        contentHash: archiveTrust.contentHash,
        previouslyApproved: wasOrcaHookPreviouslyApproved(trust, repoId, 'archive')
      }
    }
  } catch {
    return { kind: 'skip' }
  }
}

export function useHostWorktreeDelete(args: {
  client: RpcClient | null
  clientForRow: (item: Worktree) => RpcClient | null
  fetchWorktrees: () => Promise<void>
  state: HostScreenState
}) {
  const { client, clientForRow, fetchWorktrees, state } = args
  const { desktopRepos, setActionError, setLastKnownWorktrees, setWorktrees } = state
  const [archiveTrustRequest, setArchiveTrustRequest] = useState<ArchiveHookTrustRequest | null>(
    null
  )
  const [archiveTrustBusy, setArchiveTrustBusy] = useState(false)
  const [archiveHookFailure, setArchiveHookFailure] = useState<ArchiveHookFailure | null>(null)

  const removeWorktree = useCallback(
    async (item: Worktree, hooks: { runHooks: boolean; allowFailedArchiveHook?: true }) => {
      const rowClient = clientForRow(item)
      if (!rowClient) {
        return
      }
      const removeFromList = (list: Worktree[]) => removeWorktreeRow(list, item)
      const restoreRow = () => {
        setWorktrees((prev) => [...prev, item])
        setLastKnownWorktrees((prev) => [...prev, item])
      }
      setWorktrees(removeFromList)
      setLastKnownWorktrees(removeFromList)

      try {
        const reply = await worktreeRemove.request(
          rowClient,
          { worktree: `id:${item.worktreeId}`, force: true, ...hooks },
          // The host runs the archive hook before it replies; outlast it as desktop does (#19334).
          { timeoutMs: worktreeRemovalReplyTimeoutMs(hooks.runHooks) }
        )
        if (!worktreeRemove.interpret(reply).accepted) {
          restoreRow()
          if (!reply.ok && reply.error.code === ARCHIVE_HOOK_FAILED_REMOVAL_CODE) {
            setArchiveHookFailure({ item, message: reply.error.message })
          }
        }
        void fetchWorktrees()
      } catch {
        restoreRow()
      }
    },
    [clientForRow, fetchWorktrees]
  )

  const handleDeleteWorktree = useCallback(
    async (item: Worktree) => {
      const rowClient = clientForRow(item)
      if (!client || !rowClient) {
        return
      }
      const decision = await decideArchiveHookRun({
        rowClient,
        desktopClient: client,
        repos: desktopRepos,
        item
      })
      if (decision.kind === 'ask') {
        setArchiveTrustRequest({ item, prompt: decision.prompt, trust: decision.trust })
        return
      }
      await removeWorktree(item, { runHooks: decision.kind === 'run' })
    },
    [client, clientForRow, desktopRepos, removeWorktree]
  )

  const approveArchiveTrust = useCallback(
    async (alwaysTrust: boolean) => {
      const request = archiveTrustRequest
      if (!client || !request || archiveTrustBusy) {
        return
      }
      setArchiveTrustBusy(true)
      try {
        await persistOrcaHookTrustApproval({
          client,
          trust: request.trust,
          repoId: request.prompt.repoId,
          contentHash: request.prompt.contentHash,
          alwaysTrust,
          kind: 'archive'
        })
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Failed to trust archive script.')
        return
      } finally {
        setArchiveTrustBusy(false)
        setArchiveTrustRequest(null)
      }
      await removeWorktree(request.item, { runHooks: true })
    },
    [archiveTrustBusy, archiveTrustRequest, client, removeWorktree, setActionError]
  )

  const skipArchiveHook = useCallback(() => {
    const request = archiveTrustRequest
    if (!request || archiveTrustBusy) {
      return
    }
    setArchiveTrustRequest(null)
    void removeWorktree(request.item, { runHooks: false })
  }, [archiveTrustBusy, archiveTrustRequest, removeWorktree])

  const cancelArchiveTrust = useCallback(() => {
    if (!archiveTrustBusy) {
      setArchiveTrustRequest(null)
    }
  }, [archiveTrustBusy])

  // Desktop's Delete Anyway: rerun the hook with an explicit waiver for its failure.
  const deleteDespiteArchiveHookFailure = useCallback(() => {
    if (archiveHookFailure) {
      void removeWorktree(archiveHookFailure.item, {
        runHooks: true,
        allowFailedArchiveHook: true
      })
    }
  }, [archiveHookFailure, removeWorktree])

  const dismissArchiveHookFailure = useCallback(() => setArchiveHookFailure(null), [])

  return {
    archiveHookFailure,
    archiveTrustBusy,
    archiveTrustRequest,
    approveArchiveTrust,
    cancelArchiveTrust,
    deleteDespiteArchiveHookFailure,
    dismissArchiveHookFailure,
    handleDeleteWorktree,
    skipArchiveHook
  }
}
