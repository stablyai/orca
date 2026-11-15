import { z } from 'zod'
import type { CatalogRequestOptions } from '../catalog/orcad-migration-request'
import { listServerRows } from '../catalog/orcad-server-catalog-rows'
import type { Repo } from '../../../../shared/repo-types'

// repo.list returns full stored rows; omitted host fields identify server-local repos.
const ServerRepositoriesSchema = z.object({
  repos: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      connectionId: z.string().nullish(),
      executionHostId: z.string().nullish(),
      projectGroupId: z.string().nullish()
    })
  )
})

export async function listRemoteOrcadRepositories(
  pairingCode: string,
  options: CatalogRequestOptions = {}
): Promise<OrcadServerRepository[]> {
  const result = await listServerRows(pairingCode, 'repo.list', 'repositories', options)
  return ServerRepositoriesSchema.parse(result).repos.map(
    ({ id, path, connectionId, executionHostId, projectGroupId }) => ({
      id,
      path,
      ...(connectionId != null ? { connectionId } : {}),
      ...(executionHostId != null ? { executionHostId } : {}),
      ...(projectGroupId != null ? { projectGroupId } : {})
    })
  )
}

export type OrcadServerRepository = Pick<Repo, 'id' | 'path'> & {
  connectionId?: string | null
  executionHostId?: string | null
  /** Proves the server holds this group: its record, not this desktop's copy, wins on relink. */
  projectGroupId?: string | null
}
