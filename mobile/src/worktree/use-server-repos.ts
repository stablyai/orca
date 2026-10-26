import { useEffect, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc-client'
import { listServerRepos, type ListedRepo } from './server-repos'

type ServerRepo<Repo> = Repo & { executionHostId: ExecutionHostId }

// Install each server’s answer independently so a slow server cannot block other lists; generation forces a refresh.
export function useServerRepos<Repo extends ListedRepo>(
  serverClients: ReadonlyMap<ExecutionHostId, RpcClient>,
  active: boolean,
  generation = 0
): ReadonlyMap<ExecutionHostId, ServerRepo<Repo>[]> {
  const [reposByHost, setReposByHost] = useState<ReadonlyMap<ExecutionHostId, ServerRepo<Repo>[]>>(
    () => new Map()
  )

  useEffect(() => {
    setReposByHost((previous) => {
      const kept = [...previous].filter(([host]) => serverClients.has(host))
      return kept.length === previous.size ? previous : new Map(kept)
    })
    if (!active) {
      return
    }
    let stale = false
    for (const [executionHostId, serverClient] of serverClients) {
      void listServerRepos<Repo>(executionHostId, serverClient).then((listed) => {
        if (!stale && listed) {
          // An unchanged answer keeps the map, so readers keyed on it do not reload.
          setReposByHost((previous) =>
            JSON.stringify(previous.get(executionHostId)) === JSON.stringify(listed)
              ? previous
              : new Map(previous).set(executionHostId, listed)
          )
        }
      })
    }
    return () => {
      stale = true
    }
  }, [active, generation, serverClients])

  return reposByHost
}
