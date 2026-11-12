import { z } from 'zod'
import { getRepoExecutionHostId, normalizeExecutionHostId } from '../../../../shared/execution-host'
import { PluginHostCallError } from './plugin-host-call-scope'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'

const repoListAnswer = z.object({
  repos: z.array(
    z.object({
      id: z.string(),
      kind: z.string().optional(),
      executionHostId: z.string().nullable().optional(),
      connectionId: z.string().nullable().optional()
    })
  )
})

export type PluginProjectTarget = {
  id: string
  kind: 'git' | 'folder'
  /** The host the plugin named; null when it named none. */
  hostId: string | null
  /** The host of the one copy found, named or not: `local`, `ssh:…` or `runtime:…`. */
  ownerHostId: string
}

/**
 * The project a plugin names by its `project.list` id, refused with a fixed message when no
 * project has it, or when two hosts do and `hostId` does not pick one.
 */
export async function resolvePluginProject(
  call: PluginRuntimeRpc,
  projectId: string,
  hostId: string | undefined,
  ambiguousHint: string
): Promise<PluginProjectTarget> {
  const wantedHost = hostId === undefined ? undefined : normalizeExecutionHostId(hostId)
  const matches = repoListAnswer
    .parse(await call('repo.list', {}))
    .repos.filter(
      (repo) =>
        repo.id === projectId &&
        (wantedHost === undefined || getRepoExecutionHostId(repo) === wantedHost)
    )
  if (matches.length > 1) {
    throw new PluginHostCallError('action_failed', `two hosts have this project; ${ambiguousHint}`)
  }
  const [repo] = matches
  if (!repo) {
    throw new PluginHostCallError('action_failed', 'no project has this id')
  }
  return {
    id: repo.id,
    kind: repo.kind === 'folder' ? 'folder' : 'git',
    hostId: wantedHost ?? null,
    ownerHostId: getRepoExecutionHostId(repo)
  }
}
