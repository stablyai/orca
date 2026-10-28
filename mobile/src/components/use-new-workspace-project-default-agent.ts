import { useEffect, useState } from 'react'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'
import { resolveMobileNewWorkspaceDefaultAgent } from './new-workspace-project-default-agent'

type DefaultState = {
  client: RpcClient
  repoId: string
  hostId: string
  agent: TuiAgent | null
  source: 'project' | 'global' | 'automatic'
  error: string | null
}

export function useNewWorkspaceProjectDefaultAgent(
  client: RpcClient | null,
  repo: MobileWorkspaceRepo | null,
  visible: boolean
): { agent: TuiAgent | null; source: DefaultState['source']; error: string | null } | null {
  const [state, setState] = useState<DefaultState | null>(null)
  const repoId = repo?.id ?? null
  const hostId = repo ? getRepoExecutionHostId(repo) : null
  useEffect(() => {
    if (!visible || !client || !repo || !hostId) {
      return
    }
    let stale = false
    void resolveMobileNewWorkspaceDefaultAgent(client, repo)
      .then((result) => {
        if (!stale) {
          setState({ client, repoId: repo.id, hostId, ...result, error: null })
        }
      })
      .catch((error: unknown) => {
        if (!stale) {
          setState({
            client,
            repoId: repo.id,
            hostId,
            agent: null,
            source: 'automatic',
            error: error instanceof Error ? error.message : 'Could not resolve the default agent.'
          })
        }
      })
    return () => {
      stale = true
    }
  }, [client, repoId, hostId, visible])
  return state?.client === client && state.repoId === repoId && state.hostId === hostId
    ? state
    : null
}
