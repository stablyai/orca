import { useCallback, useMemo } from 'react'
import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import {
  HOST_LIST_TARGET,
  NO_HOST_LIST_INPUT,
  hostRepoCatalogQuery,
  type HostRepoCatalog
} from '../host-screen/catalog/host-list-queries'
import { hostObserverOptions } from '../query/host-query'
import type { CommanderMobileData } from './commander-mobile-data'
import { commanderProjects } from './commander-projects'

export function useCommanderProjects(data: CommanderMobileData, active: boolean) {
  const queries = useMemo(
    () =>
      data.allClients.map(({ hostId, client }) => ({
        ...hostObserverOptions(
          hostRepoCatalogQuery,
          client,
          hostId,
          HOST_LIST_TARGET,
          NO_HOST_LIST_INPUT
        ),
        enabled: active && data.hostStates[hostId] === 'connected'
      })),
    [data.allClients, data.hostStates, active]
  )
  const { allClients, agentList } = data
  const combine = useCallback(
    (results: UseQueryResult<HostRepoCatalog>[]) => {
      const projects = allClients.flatMap(({ hostId }, i) =>
        (results[i]?.data?.catalog ?? []).map((repo) => ({
          hostId,
          executionHostId: getRepoExecutionHostId(repo),
          repoId: repo.id,
          name: repo.displayName
        }))
      )
      return commanderProjects(agentList, projects)
    },
    [allClients, agentList]
  )
  return useQueries({ queries, subscribed: active, combine })
}
