import { useCallback, useRef, useState } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../../src/shared/workspace-setup/orca-yaml-hook-types'
import { ARCHIVE_HOOK_FAILED_REMOVAL_CODE } from '../../../../src/shared/worktree/removal/archive-hook-removal-gate'
import type { OrcaHookTrustPrompt } from '../../components/hook-trust/OrcaHookTrustDrawer'
import { persistOrcaHookTrustApproval } from '../../new-workspace/creation/setup-hook-trust'
import { triggerError, triggerSuccess } from '../../platform/haptics/haptics'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { requestWorktreeRemove } from './worktree-remove-request'
import { removeWorktreeRow } from '../../worktree/row-presentation/worktree-host-row-identity'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import type { HostScreenState } from '../use-host-screen-state'
import { useWorktreeDeleteFailure } from './use-worktree-delete-failure'
import { decideArchiveHookRun } from './archive-hook-run-decision'

// Keep the clients the delete started on, so a host switch cannot redirect a pending approval.
export type RowClients = { rowClient: RpcClient; desktopClient: RpcClient }

// Delete Anyway's explicit waiver for a failed hook, carried through the trust prompt.
type ArchiveHookWaiver = { allowFailedArchiveHook?: true }

export type ArchiveHookTrustRequest = RowClients & {
  item: Worktree
  prompt: OrcaHookTrustPrompt
  trust: PersistedTrustedOrcaHooks
  repos: readonly { id: string }[] | null
  waiver: ArchiveHookWaiver
}

export type ArchiveHookFailure = RowClients & {
  item: Worktree
  message: string
  /** The script content approved for this delete, so Delete Anyway doesn't ask again. */
  approvedArchiveHash?: string
}

export function useHostWorktreeDelete(args: {
  client: RpcClient | null
  clientForRow: (item: Worktree) => RpcClient | null
  fetchWorktrees: () => Promise<void>
  state: HostScreenState
}) {
  const { client, clientForRow, fetchWorktrees, state } = args
  const { reportDeleteFailure, ...deleteFailure } = useWorktreeDeleteFailure(client)
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
  const [archiveHookFailure, setArchiveHookFailure] = useState<ArchiveHookFailure | null>(null)
  // A prompt or failure belongs to the desktop it started on; after a host switch it is gone, never acted on.
  const onThisDesktop = useCallback(
    <Entry extends RowClients>(entry: Entry | null) =>
      entry && client && entry.desktopClient === client ? entry : null,
    [client]
  )

  const hideRow = useCallback((item: Worktree) => {
    const removeFromList = (list: Worktree[]) => removeWorktreeRow(list, item)
    setWorktrees(removeFromList)
    setLastKnownWorktrees(removeFromList)
  }, [])
  const restoreRow = useCallback((item: Worktree) => {
    // Server rows live in serverWorkspaces, not the desktop's lists; a poll may also have re-added the row.
    if (item.hostId?.startsWith('runtime:')) {
      return
    }
    const putBack = (list: Worktree[]) => [...removeWorktreeRow(list, item), item]
    setWorktrees(putBack)
    setLastKnownWorktrees(putBack)
  }, [])

  const removeWorktree = useCallback(
    async (
      item: Worktree,
      clients: RowClients,
      hooks: ArchiveHookWaiver & { runHooks: boolean },
      approvedArchiveHash?: string
    ) => {
      hideRow(item)
      try {
        const result = await requestWorktreeRemove(clients.rowClient, item, hooks)
        if (result.accepted) {
          triggerSuccess()
          return
        }
        triggerError()
        restoreRow(item)
        if (result.refusal?.code === ARCHIVE_HOOK_FAILED_REMOVAL_CODE) {
          setArchiveHookFailure({
            rowClient: clients.rowClient,
            desktopClient: clients.desktopClient,
            item,
            message: result.refusal.message,
            ...(approvedArchiveHash ? { approvedArchiveHash } : {})
          })
        } else {
          reportDeleteFailure(clients.desktopClient, item, result.refusal)
        }
      } catch (error) {
        triggerError()
        restoreRow(item)
        reportDeleteFailure(
          clients.desktopClient,
          item,
          error instanceof Error ? error : new Error(String(error))
        )
      } finally {
        void fetchWorktrees()
      }
    },
    [fetchWorktrees, hideRow, reportDeleteFailure, restoreRow]
  )

  // Every attempt, Delete Anyway included, re-reads the script: it may have changed since approval.
  const deleteWithArchiveTrust = useCallback(
    async (
      item: Worktree,
      clients: RowClients,
      waiver: ArchiveHookWaiver,
      approvedArchiveHash?: string
    ) => {
      // Hide at once, as before trust was asked; the row returns if the delete is cancelled.
      hideRow(item)
      // Count each server-owned repo once: an always-trust must not cover a same-id repo on another host.
      const serverRepos = new Map(
        serverWorkspaces.worktrees.map((row) => [
          `${row.hostId}\0${row.repoId}`,
          { id: row.repoId }
        ])
      )
      const decision = await decideArchiveHookRun({
        ...clients,
        // Without the desktop's catalog a same-id repo elsewhere can't be ruled out, so only an exact-script approval counts.
        repos: desktopRepos.length > 0 ? [...desktopRepos, ...serverRepos.values()] : null,
        item,
        approvedArchiveHash
      })
      if (decision.kind !== 'ask') {
        await removeWorktree(
          item,
          clients,
          { runHooks: decision.kind === 'run', ...waiver },
          decision.kind === 'run' ? approvedArchiveHash : undefined
        )
        return
      }
      // One prompt at a time; a later delete waiting on trust is left undone.
      if (onThisDesktop(archiveTrustRequestRef.current)) {
        restoreRow(item)
        return
      }
      setArchiveTrustRequest({
        ...clients,
        item,
        prompt: decision.prompt,
        trust: decision.trust,
        repos: decision.repos,
        waiver
      })
    },
    [
      desktopRepos,
      hideRow,
      onThisDesktop,
      removeWorktree,
      restoreRow,
      serverWorkspaces,
      setArchiveTrustRequest
    ]
  )

  const handleDeleteWorktree = useCallback(
    async (item: Worktree) => {
      const rowClient = clientForRow(item)
      if (client && rowClient) {
        await deleteWithArchiveTrust(item, { rowClient, desktopClient: client }, {})
      }
    },
    [client, clientForRow, deleteWithArchiveTrust]
  )

  // Taken synchronously so a second tap on the drawer finds nothing to act on.
  const takeArchiveTrustRequest = useCallback(() => {
    const request = onThisDesktop(archiveTrustRequestRef.current)
    setArchiveTrustRequest(null)
    return request
  }, [onThisDesktop, setArchiveTrustRequest])

  const approveArchiveTrust = useCallback(
    async (alwaysTrust: boolean) => {
      const request = takeArchiveTrustRequest()
      if (!request) {
        return
      }
      try {
        await persistOrcaHookTrustApproval({
          client: request.desktopClient,
          trust: request.trust,
          repos: request.repos,
          repoId: request.prompt.repoId,
          contentHash: request.prompt.contentHash,
          alwaysTrust,
          kind: 'archive'
        })
      } catch (error) {
        restoreRow(request.item)
        setActionError(error instanceof Error ? error.message : 'Failed to trust archive script.')
        return
      }
      await removeWorktree(
        request.item,
        request,
        { runHooks: true, ...request.waiver },
        request.prompt.contentHash
      )
    },
    [removeWorktree, restoreRow, setActionError, takeArchiveTrustRequest]
  )

  const skipArchiveHook = useCallback(() => {
    const request = takeArchiveTrustRequest()
    if (request) {
      void removeWorktree(request.item, request, { runHooks: false })
    }
  }, [removeWorktree, takeArchiveTrustRequest])

  const cancelArchiveTrust = useCallback(() => {
    const request = takeArchiveTrustRequest()
    if (request) {
      restoreRow(request.item)
    }
  }, [restoreRow, takeArchiveTrustRequest])

  const visibleFailure = onThisDesktop(archiveHookFailure)

  // Desktop's Delete Anyway: rerun the trusted hook with an explicit waiver for its failure.
  const deleteDespiteArchiveHookFailure = useCallback(() => {
    if (visibleFailure) {
      void deleteWithArchiveTrust(
        visibleFailure.item,
        visibleFailure,
        { allowFailedArchiveHook: true },
        visibleFailure.approvedArchiveHash
      )
    }
  }, [visibleFailure, deleteWithArchiveTrust])

  const dismissArchiveHookFailure = useCallback(() => setArchiveHookFailure(null), [])

  return {
    ...deleteFailure,
    archiveHookFailure: visibleFailure,
    archiveTrustRequest: onThisDesktop(archiveTrustRequest),
    approveArchiveTrust,
    cancelArchiveTrust,
    deleteDespiteArchiveHookFailure,
    dismissArchiveHookFailure,
    handleDeleteWorktree,
    skipArchiveHook
  }
}
