import { useCallback } from 'react'
import { getAutomationRunRepoId } from '../../../src/shared/automations/history/automation-run-identity'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { getRuntimePathBasename } from '../../../src/shared/file-access/cross-platform-path'
import {
  HOST_LIST_TARGET,
  hostRepoCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../host-screen/catalog/host-list-queries'
import { useHostQuery } from '../query/host-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { MobileAutomationRow } from './automation-reply-schema'

/** Names an automation's project by its repo's display name, as desktop's list does. */
export function useAutomationProjectNames(
  hostId: string,
  client: RpcClient | null,
  // A paired server's repos aren't the paired host's cached list, so those fall back to the folder name.
  pairedHost: boolean
): (automation: MobileAutomationRow['automation']) => string | undefined {
  const repos = useHostQuery(
    hostRepoCatalogQuery,
    { hostId, client },
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    { enabled: pairedHost && hostId !== '' }
  )
  const catalog = pairedHost ? repos.data?.catalog : undefined
  return useCallback(
    (automation) => {
      const repoId = getAutomationRunRepoId(automation)
      const context = automation.runContext
      const matches = catalog?.filter((repo) => repo.id === repoId) ?? []
      const repo =
        matches.find((entry) => getRepoExecutionHostId(entry) === context?.hostId) ?? matches[0]
      return (
        repo?.displayName ||
        (context ? getRuntimePathBasename(context.path) : undefined) ||
        undefined
      )
    },
    [catalog]
  )
}
