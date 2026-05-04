import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'

const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

const RepoPath = z.object({
  path: requiredString('Missing repo path')
})

const RepoSetBaseRef = z.object({
  repo: requiredString('Missing repo selector'),
  ref: requiredString('Missing base ref')
})

const RepoSearchRefs = z.object({
  repo: requiredString('Missing repo selector'),
  query: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : undefined))
    .pipe(z.string({ message: 'Missing query' })),
  limit: OptionalFiniteNumber
})

export const REPO_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'repo.list',
    params: null,
    handler: (_params, { runtime }) => ({ repos: runtime.listRepos() })
  }),
  defineMethod({
    name: 'repo.add',
    params: RepoPath,
    handler: async (params, { runtime }) => ({ repo: await runtime.addRepo(params.path) })
  }),
  defineMethod({
    name: 'repo.show',
    params: RepoSelector,
    handler: async (params, { runtime }) => ({ repo: await runtime.showRepo(params.repo) })
  }),
  defineMethod({
    name: 'repo.setBaseRef',
    params: RepoSetBaseRef,
    handler: async (params, { runtime }) => ({
      repo: await runtime.setRepoBaseRef(params.repo, params.ref)
    })
  }),
  defineMethod({
    name: 'repo.searchRefs',
    params: RepoSearchRefs,
    handler: async (params, { runtime }) =>
      runtime.searchRepoRefs(params.repo, params.query, params.limit)
  })
]
