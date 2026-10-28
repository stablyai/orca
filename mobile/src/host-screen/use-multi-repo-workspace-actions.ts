import { useCallback, useMemo, useState } from 'react'
import { rpcClientForExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import { multiRepoRetryMember } from '../worktree/multi-repo-workspace-operations'
import {
  multiRepoMemberOpenTarget,
  type MobileMultiRepoMember
} from '../worktree/multi-repo-workspace-summary'
import type { Worktree } from '../worktree/workspace-list-types'

const RETRY_TIMEOUT_MS = 120_000

type Args = {
  client: RpcClient | null
  hostCapabilities: readonly string[]
  openWorktree: (item: Worktree) => void
  reportError: (message: string) => void
}

export function useMultiRepoWorkspaceActions({
  client,
  hostCapabilities,
  openWorktree,
  reportError
}: Args) {
  const [retryingMemberIds, setRetryingMemberIds] = useState<ReadonlySet<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<Worktree | null>(null)

  const openMember = useCallback(
    (parent: Worktree, member: MobileMultiRepoMember) => {
      const target = multiRepoMemberOpenTarget(parent, member)
      if (target) {
        openWorktree(target)
      }
    },
    [openWorktree]
  )

  const retryMember = useCallback(
    async (parent: Worktree, member: MobileMultiRepoMember) => {
      const rowClient = client && rpcClientForExecutionHost(client, hostCapabilities, parent.hostId)
      if (!rowClient || !parent.multiRepo) {
        return
      }
      setRetryingMemberIds((prev) => new Set(prev).add(member.memberId))
      try {
        const reply = await multiRepoRetryMember.request(
          rowClient,
          { folderWorkspaceId: parent.multiRepo.folderWorkspaceId, memberId: member.memberId },
          { timeoutMs: RETRY_TIMEOUT_MS }
        )
        multiRepoRetryMember.interpret(reply)
      } catch (error) {
        reportError(error instanceof Error ? error.message : `Could not retry ${member.dirName}`)
      } finally {
        setRetryingMemberIds((prev) => {
          const next = new Set(prev)
          next.delete(member.memberId)
          return next
        })
      }
    },
    [client, hostCapabilities, reportError]
  )

  const deleteClient = useMemo(
    () =>
      client && deleteTarget
        ? rpcClientForExecutionHost(client, hostCapabilities, deleteTarget.hostId)
        : null,
    [client, hostCapabilities, deleteTarget]
  )

  return {
    deleteClient,
    deleteTarget,
    openDelete: setDeleteTarget,
    closeDelete: useCallback(() => setDeleteTarget(null), []),
    openMember,
    retryMember,
    retryingMemberIds
  }
}
