import * as z from 'zod'
import type { WorktreeAtRiskLocalFiles } from '../../../../src/shared/worktree/removal/at-risk-local-files'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'
import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import { folderIdOfSelector } from '../../../../src/shared/workspace/identity/workspace-scope'
import { defineHostQuery, useHostQuery } from '../../query/host-query'
import {
  gitStatusSummaryQuery,
  serverGitStatusSummaryQuery
} from '../../source-control/changes/mobile-git-status-query'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'

type AtRiskLocalFiles = Pick<WorktreeAtRiskLocalFiles, 'count' | 'samplePaths' | 'complete'>

// Hosts from before phones could ask refuse it; the confirm then names no ignored files.
const atRiskLocalFilesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.at-risk-local-files-or-skip',
    method: 'git.atRiskLocalFiles',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'at-risk-local-files',
      z.looseObject({
        count: z.number(),
        samplePaths: z.array(z.string()),
        complete: z.boolean()
      })
    )
  })
)

function isOlderHostRefusal(code: string): boolean {
  return code === 'method_not_found' || code === 'forbidden'
}

// Each read walks the worktree's ignored files, so a reopened confirm reuses a recent answer.
const atRiskLocalFilesQuery = defineHostQuery({
  family: 'git.atRiskLocalFiles',
  staleTime: 15_000,
  fetch: async (client: RpcClient, target): Promise<AtRiskLocalFiles | null> => {
    const outcome = await atRiskLocalFilesRead.request(client, {
      worktree: `id:${target.worktree ?? ''}`
    })
    // Only an older host's refusal means "no scan"; any other refusal is a scan that failed.
    if (!outcome.ok && !isOlderHostRefusal(outcome.error.code)) {
      throw new Error('Ignored-files scan failed')
    }
    const reply = atRiskLocalFilesRead.interpret(outcome)
    return reply.accepted ? reply.value : null
  }
})

export type WorkspaceDeleteLoss =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'unchecked' }
  | { kind: 'known'; changeCount: number; ignoredFiles: AtRiskLocalFiles | null }

/** What desktop's delete dialog warns about, read on the row's own host: uncommitted changes and
 *  ignored files only this worktree holds. Folder rows and primary checkouts lose no files. */
export function useWorkspaceDeleteLoss(args: {
  hostId: string
  /** The client that reaches the row's host, or null when it can't be reached. */
  rowClient: RpcClient | null
  routeHost: ExecutionHostId | undefined
  row: Pick<Worktree, 'worktreeId' | 'isMainWorktree'>
}): WorkspaceDeleteLoss {
  const { hostId, rowClient, routeHost, row } = args
  const enabled = folderIdOfSelector(row.worktreeId) === undefined && row.isMainWorktree !== true
  const host = { hostId, client: enabled ? rowClient : null }
  const target = { exec: routeHost ?? LOCAL_EXECUTION_HOST_ID, worktree: row.worktreeId }
  const status = useHostQuery(
    routeHost ? serverGitStatusSummaryQuery : gitStatusSummaryQuery,
    host,
    target,
    {}
  )
  const ignored = useHostQuery(atRiskLocalFilesQuery, host, target, {})
  if (!enabled) {
    return { kind: 'none' }
  }
  if (!rowClient) {
    return { kind: 'unchecked' }
  }
  if (status.isPending || ignored.isPending) {
    return { kind: 'checking' }
  }
  if (status.data?.kind !== 'ready' || status.data.status.readError) {
    return { kind: 'unchecked' }
  }
  return {
    kind: 'known',
    changeCount: status.data.status.entries.length,
    // null is a host that predates the scan; undefined is a scan that failed, which is never "no files".
    ignoredFiles:
      ignored.isError || ignored.data === undefined
        ? { count: 0, samplePaths: [], complete: false }
        : ignored.data
  }
}
