import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

const RepoPath = z.object({
  path: requiredString('Missing repo path'),
  kind: z.enum(['git', 'folder']).optional()
})

const RepoCreate = z.object({
  parentPath: requiredString('Missing parent path'),
  name: requiredString('Missing repo name'),
  kind: z.enum(['git', 'folder']).optional()
})

const RepoClone = z.object({
  url: requiredString('Missing clone URL'),
  destination: requiredString('Missing clone destination')
})

const RepoSetBaseRef = z.object({
  repo: requiredString('Missing repo selector'),
  ref: requiredString('Missing base ref')
})

const RepoUpdate = RepoSelector.extend({
  updates: z.object({
    displayName: OptionalString,
    badgeColor: OptionalString,
    hookSettings: z.unknown().optional(),
    worktreeBaseRef: OptionalString,
    kind: z.enum(['git', 'folder']).optional(),
    symlinkPaths: z.array(z.string()).optional(),
    issueSourcePreference: z.enum(['auto', 'github', 'linear']).optional()
  })
})

const RepoSearchRefs = z.object({
  repo: requiredString('Missing repo selector'),
  query: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : undefined))
    .pipe(z.string({ message: 'Missing query' })),
  limit: OptionalFiniteNumber
})

const RepoReorder = z.object({
  orderedIds: z.array(z.string())
})

const RepoIssueCommandWrite = RepoSelector.extend({
  content: z.string()
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
    handler: async (params, { runtime }) => ({
      repo: await runtime.addRepo(params.path, params.kind)
    })
  }),
  defineMethod({
    name: 'repo.create',
    params: RepoCreate,
    handler: async (params, { runtime }) =>
      runtime.createRepo(params.parentPath, params.name, params.kind)
  }),
  defineMethod({
    name: 'repo.clone',
    params: RepoClone,
    handler: async (params, { runtime }) => ({
      repo: await runtime.cloneRepo(params.url, params.destination)
    })
  }),
  defineMethod({
    name: 'repo.show',
    params: RepoSelector,
    handler: async (params, { runtime }) => ({ repo: await runtime.showRepo(params.repo) })
  }),
  defineMethod({
    name: 'repo.update',
    params: RepoUpdate,
    handler: async (params, { runtime }) => ({
      repo: await runtime.updateRepo(
        params.repo,
        params.updates as Parameters<typeof runtime.updateRepo>[1]
      )
    })
  }),
  defineMethod({
    name: 'repo.rm',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.removeRepo(params.repo)
  }),
  defineMethod({
    name: 'repo.reorder',
    params: RepoReorder,
    handler: async (params, { runtime }) => runtime.reorderRepos(params.orderedIds)
  }),
  defineMethod({
    name: 'repo.setBaseRef',
    params: RepoSetBaseRef,
    handler: async (params, { runtime }) => ({
      repo: await runtime.setRepoBaseRef(params.repo, params.ref)
    })
  }),
  defineMethod({
    name: 'repo.baseRefDefault',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoBaseRefDefault(params.repo)
  }),
  defineMethod({
    name: 'repo.searchRefs',
    params: RepoSearchRefs,
    handler: async (params, { runtime }) =>
      runtime.searchRepoRefs(params.repo, params.query, params.limit)
  }),
  defineMethod({
    name: 'repo.hooks',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoHooks(params.repo)
  }),
  defineMethod({
    name: 'repo.hooksCheck',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.checkRepoHooks(params.repo)
  }),
  defineMethod({
    name: 'repo.issueCommandRead',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.readRepoIssueCommand(params.repo)
  }),
  defineMethod({
    name: 'repo.issueCommandWrite',
    params: RepoIssueCommandWrite,
    handler: async (params, { runtime }) =>
      runtime.writeRepoIssueCommand(params.repo, params.content)
  })
]
