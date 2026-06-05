import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { sanitizeRepoIcon } from '../../../../shared/repo-icon'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'

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

const RepoSourceControlAiOverrides = z
  .unknown()
  .optional()
  .transform((value) =>
    value === undefined ? undefined : normalizeRepoSourceControlAiOverrides(value)
  )

const RepoBadgeColor = z
  .unknown()
  .optional()
  .transform((value) =>
    value === undefined ? undefined : (normalizeRepoBadgeColor(value) ?? undefined)
  )

const RepoUpstream = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1)
  })
  .nullable()
  .optional()

const RepoUpdate = RepoSelector.extend({
  updates: z.object({
    displayName: OptionalString,
    badgeColor: RepoBadgeColor,
    repoIcon: z
      .unknown()
      .transform((value) => sanitizeRepoIcon(value))
      .optional(),
    upstream: RepoUpstream,
    hookSettings: z.unknown().optional(),
    worktreeBaseRef: OptionalString,
    worktreeBasePath: OptionalString,
    kind: z.enum(['git', 'folder']).optional(),
    symlinkPaths: z.array(z.string()).optional(),
    issueSourcePreference: z.enum(['auto', 'upstream', 'origin']).optional(),
    externalWorktreeVisibility: z.enum(['hide', 'show']).optional(),
    externalWorktreeVisibilityPromptDismissedAt: z.number().finite().optional(),
    projectGroupId: OptionalString.nullable().optional(),
    projectGroupOrder: OptionalFiniteNumber,
    sourceControlAi: RepoSourceControlAiOverrides
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

const ProjectGroupCreate = z.object({
  name: requiredString('Missing group name'),
  parentPath: OptionalString,
  parentGroupId: OptionalString.nullable().optional(),
  createdFrom: z.enum(['manual', 'folder-scan', 'migration']).optional()
})

const ProjectGroupUpdate = z.object({
  groupId: requiredString('Missing group id'),
  updates: z.object({
    name: OptionalString,
    isCollapsed: z.boolean().optional(),
    tabOrder: OptionalFiniteNumber,
    color: OptionalString.nullable().optional()
  })
})

const ProjectGroupSelector = z.object({
  groupId: requiredString('Missing group id')
})

const ProjectGroupMoveProject = z.object({
  repo: requiredString('Missing repo selector'),
  groupId: OptionalString.nullable(),
  order: OptionalFiniteNumber
})

const ProjectGroupScanNested = z.object({
  path: requiredString('Missing folder path')
})

const ProjectGroupImportNested = z.discriminatedUnion('mode', [
  z.object({
    parentPath: requiredString('Missing parent path'),
    groupName: z.string().optional().default(''),
    projectPaths: z.array(z.string()),
    mode: z.literal('group')
  }),
  z.object({
    parentPath: requiredString('Missing parent path'),
    // Why: blank group names fall back to the scanned folder basename; separate
    // imports do not create a group but share the same renderer payload shape.
    groupName: z.string().optional().default(''),
    projectPaths: z.array(z.string()),
    mode: z.literal('separate')
  })
])

const RepoIssueCommandWrite = RepoSelector.extend({
  content: z.string()
})

const RepoSparsePresetSave = RepoSelector.extend({
  id: OptionalString,
  name: requiredString('Missing preset name'),
  directories: z.array(z.string())
})

export const REPO_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'repo.list',
    params: null,
    handler: (_params, { runtime }) => ({ repos: runtime.listRepos() })
  }),
  defineMethod({
    name: 'projectGroup.list',
    params: null,
    handler: (_params, { runtime }) => ({ groups: runtime.listProjectGroups() })
  }),
  defineMethod({
    name: 'projectGroup.create',
    params: ProjectGroupCreate,
    handler: async (params, { runtime }) => ({
      group: await runtime.createProjectGroup(params)
    })
  }),
  defineMethod({
    name: 'projectGroup.update',
    params: ProjectGroupUpdate,
    handler: async (params, { runtime }) => ({
      group: await runtime.updateProjectGroup(params.groupId, params.updates)
    })
  }),
  defineMethod({
    name: 'projectGroup.delete',
    params: ProjectGroupSelector,
    handler: async (params, { runtime }) => runtime.deleteProjectGroup(params.groupId)
  }),
  defineMethod({
    name: 'projectGroup.moveProject',
    params: ProjectGroupMoveProject,
    handler: async (params, { runtime }) => ({
      repo: await runtime.moveProjectToGroup(params.repo, params.groupId ?? null, params.order)
    })
  }),
  defineMethod({
    name: 'projectGroup.scanNested',
    params: ProjectGroupScanNested,
    handler: async (params, { runtime }) => runtime.scanNestedRepos(params.path)
  }),
  defineMethod({
    name: 'projectGroup.importNested',
    params: ProjectGroupImportNested,
    handler: async (params, { runtime }) => runtime.importNestedRepos(params)
  }),
  defineMethod({
    name: 'repo.sparsePresets',
    params: RepoSelector,
    handler: async (params, { runtime }) => ({
      presets: await runtime.listSparsePresets(params.repo)
    })
  }),
  defineMethod({
    name: 'repo.saveSparsePreset',
    params: RepoSparsePresetSave,
    handler: async (params, { runtime }) => ({
      preset: await runtime.saveSparsePreset(params.repo, {
        ...(params.id ? { id: params.id } : {}),
        name: params.name,
        directories: params.directories
      })
    })
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
    handler: async (params, { runtime }) => runtime.removeProject(params.repo)
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
    name: 'repo.setupScriptImports',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.inspectRepoSetupScriptImports(params.repo)
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
