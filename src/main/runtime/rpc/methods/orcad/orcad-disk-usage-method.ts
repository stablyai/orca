import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { defineMethod } from '../../core'
import {
  ORCAD_DISK_USAGE_METHOD,
  OrcadDiskUsageParamsSchema
} from '../../../../../shared/orcad-disk-usage'
import type { Repo } from '../../../../../shared/repo-types'
import { readOrcadDiskUsage } from '../../../../orcad/orcad-disk-usage'

/** Workspace root first so it leads the result; then local repo checkouts and $HOME. */
export function orcadDiskUsageProbePaths(args: {
  workspaceDir: string | null | undefined
  repos: readonly Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>[]
  home: string
}): string[] {
  const repoPaths = args.repos
    .filter(
      (repo) =>
        !repo.connectionId &&
        (!repo.executionHostId || repo.executionHostId === 'local') &&
        isAbsolute(repo.path)
    )
    .map((repo) => repo.path)
  return [args.workspaceDir ?? '', ...repoPaths, args.home].filter(Boolean)
}

export const ORCAD_DISK_USAGE_METHODS = [
  defineMethod({
    name: ORCAD_DISK_USAGE_METHOD,
    // Why workspace: free space is no more sensitive than the file listings this caller can already read.
    permission: 'workspace',
    params: OrcadDiskUsageParamsSchema,
    handler: async (_params, { runtime }) => {
      const store = runtime.requireStore()
      return readOrcadDiskUsage(
        orcadDiskUsageProbePaths({
          workspaceDir: store.getSettings().workspaceDir,
          repos: store.getRepos(),
          home: homedir()
        })
      )
    }
  })
]
