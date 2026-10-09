import { defineMethod } from '../core'
import { BacklogRequest } from '../../../../shared/rpc-contract/backlog-params'
import { routeBacklogOperation } from '../../../backlog/backlog-host'

export const BACKLOG_METHODS = [
  defineMethod({
    name: 'backlog.execute',
    params: BacklogRequest,
    /** Resolves a registered repo ID on this runtime; callers cannot supply an arbitrary path. */
    handler: async (params, { runtime }) => {
      const repo = runtime.listRepos().find((candidate) => candidate.id === params.repoId)
      if (!repo) {
        throw new Error('Backlog project is not registered on this runtime.')
      }
      return routeBacklogOperation(repo, params.operation)
    }
  })
]
