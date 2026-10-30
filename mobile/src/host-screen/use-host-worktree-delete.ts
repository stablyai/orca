import { useCallback, useRef, useState } from 'react'
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

// Keep the clients the delete started on, so a host switch cannot redirect a pending approval.
type RowClients = { rowClient: RpcClient; desktopClient: RpcClient }

export type ArchiveHookTrustRequest = RowClients & {
  item: Worktree
  prompt: OrcaHookTrustPrompt
  trust: PersistedTrustedOrcaHooks
}

export type ArchiveHookFailure = { item: Worktree; message: string; rowClient: RpcClient }

// Desktop's ensureHooksConfirmed('archive'): a script that cannot be inspected or checked against trust does not run.
async function decideArchiveHookRun(
  args: RowClients & { repos: readonly { id: string }[]; item: Worktree }
): Promise<ArchiveHookDecision> {
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
  const { desktopRepos, serverWorkspaces, setActionError, setLastKnownWorktrees, setWorktrees } =
    state
  const [archiveTrustRequest, setArchiveTrustRequestState] =
    useState<ArchiveHookTrustRequest | null>(null)
  // Read synchronously when a second delete resolves while a prompt is up.
  const archiveTrustRequestRef = useRef<ArchiveHookTrustRequest | null>(null)
  const setArchiveTrustRequest = useCallback((request: ArchiveHookTrustRequest | null) => {
    archiveTrustRequestRef.current = request
    setArchiveTrustRequestState(request)
  }, [])
  const [archiveTrustBusy, setArchiveTrustBusy] = useState(false)
  const [archiveHookFailure, setArchiveHookFailure] = useState<ArchiveHookFailure | null>(null)

  const hideRow = useCallback((item: Worktree) => {
    const removeFromList = (list: Worktree[]) => removeWorktreeRow(list, item)
    setWorktrees(removeFromList)
    setLastKnownWorktrees(removeFromList)
  }, [])
  const restoreRow = useCallback((item: Worktree) => {
    setWorktrees((prev) => [...prev, item])
    setLastKnownWorktrees((prev) => [...prev, item])
  }, [])

  const removeWorktree = useCallback(
    async (
      item: Worktree,
      rowClient: RpcClient,
      hooks: { runHooks: boolean; allowFailedArchiveHook?: true }
    ) => {
      hideRow(item)
      try {
        const reply = await worktreeRemove.request(
          rowClient,
          { worktree: `id:${item.worktreeId}`, force: true, ...hooks },
          // The host runs the archive hook before it replies; outlast it as desktop does (#19334).
          { timeoutMs: worktreeRemovalReplyTimeoutMs(hooks.runHooks) }
        )
        if (!worktreeRemove.interpret(reply).accepted) {
          restoreRow(item)
          if (!reply.ok && reply.error.code === ARCHIVE_HOOK_FAILED_REMOVAL_CODE) {
            setArchiveHookFailure({ item, message: reply.error.message, rowClient })
          }
        }
        void fetchWorktrees()
      } catch {
        restoreRow(item)
      }
    },
    [fetchWorktrees, hideRow, restoreRow]
  )

  const handleDeleteWorktree = useCallback(
    async (item: Worktree) => {
      const rowClient = clientForRow(item)
      if (!client || !rowClient) {
        return
      }
      // Hide at once, as before trust was asked; the row returns if the delete is cancelled.
      hideRow(item)
      const decision = await decideArchiveHookRun({
        rowClient,
        desktopClient: client,
        // Count server-owned copies too: an always-trust must not cover a same-id repo on another host.
        repos: [...desktopRepos, ...serverWorkspaces.worktrees.map((row) => ({ id: row.repoId }))],
        item
      })
      if (decision.kind !== 'ask') {
        await removeWorktree(item, rowClient, { runHooks: decision.kind === 'run' })
        return
      }
      // One prompt at a time; a later delete waiting on trust is left undone.
      if (archiveTrustRequestRef.current) {
        restoreRow(item)
        return
      }
      setArchiveTrustRequest({
        item,
        prompt: decision.prompt,
        trust: decision.trust,
        rowClient,
        desktopClient: client
      })
    },
    [
      client,
      clientForRow,
      desktopRepos,
      hideRow,
      removeWorktree,
      restoreRow,
      serverWorkspaces,
      setArchiveTrustRequest
    ]
  )

  const approveArchiveTrust = useCallback(
    async (alwaysTrust: boolean) => {
      const request = archiveTrustRequest
      if (!request || archiveTrustBusy) {
        return
      }
      setArchiveTrustBusy(true)
      try {
        await persistOrcaHookTrustApproval({
          client: request.desktopClient,
          trust: request.trust,
          repoId: request.prompt.repoId,
          contentHash: request.prompt.contentHash,
          alwaysTrust,
          kind: 'archive'
        })
      } catch (error) {
        restoreRow(request.item)
        setActionError(error instanceof Error ? error.message : 'Failed to trust archive script.')
        return
      } finally {
        setArchiveTrustBusy(false)
        setArchiveTrustRequest(null)
      }
      await removeWorktree(request.item, request.rowClient, { runHooks: true })
    },
    [
      archiveTrustBusy,
      archiveTrustRequest,
      removeWorktree,
      restoreRow,
      setActionError,
      setArchiveTrustRequest
    ]
  )

  const skipArchiveHook = useCallback(() => {
    const request = archiveTrustRequest
    if (!request || archiveTrustBusy) {
      return
    }
    setArchiveTrustRequest(null)
    void removeWorktree(request.item, request.rowClient, { runHooks: false })
  }, [archiveTrustBusy, archiveTrustRequest, removeWorktree, setArchiveTrustRequest])

  const cancelArchiveTrust = useCallback(() => {
    if (archiveTrustRequest && !archiveTrustBusy) {
      restoreRow(archiveTrustRequest.item)
      setArchiveTrustRequest(null)
    }
  }, [archiveTrustBusy, archiveTrustRequest, restoreRow, setArchiveTrustRequest])

  // Desktop's Delete Anyway: rerun the hook with an explicit waiver for its failure.
  const deleteDespiteArchiveHookFailure = useCallback(() => {
    if (archiveHookFailure) {
      void removeWorktree(archiveHookFailure.item, archiveHookFailure.rowClient, {
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
