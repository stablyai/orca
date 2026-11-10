import { useEffect } from 'react'
import * as z from 'zod'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import { ProjectSectionCatalogSchema } from '../../../src/shared/project-section-catalog-schema'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import { defineHostQuery, useHostQuery } from '../query/host-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  hostProjectGroupsRead,
  projectSectionsRead,
  readServedProjectSections,
  type ServedProjectSections
} from '../worktree/project-sections-operations'
import { readHostMethodReply } from './host-sidebar-feed-operations'
import { HOST_LIST_TARGET, NO_HOST_LIST_INPUT } from './host-list-queries'
import type { HostScreenState } from './use-host-screen-state'

type HostProjectSections = {
  sections: ServedProjectSections | null
  // Read only by a feed-built list whose window catalog carries no groups.
  groups: readonly ProjectGroup[] | null
}

export const hostProjectSectionsQuery = defineHostQuery({
  family: 'project.sections',
  fetch: async (
    client,
    _target,
    _input: typeof NO_HOST_LIST_INPUT
  ): Promise<HostProjectSections> => {
    const reply = await projectSectionsRead.request(client).catch(() => null)
    const sections = readServedProjectSections(reply)
    if (sections.kind !== 'answered') {
      throw new Error('project sections unavailable')
    }
    // Switch point: with no window catalog's groups, a feed-built list reads the host's own.
    if (!ORCA_SIDEBAR_INPUTS_IS_MAIN || sections.value?.projectGroups) {
      return { sections: sections.value, groups: null }
    }
    const groupReply = await hostProjectGroupsRead.request(client).catch(() => null)
    const groups = groupReply && readHostMethodReply(groupReply, hostProjectGroupsRead.interpret)
    return { sections: sections.value, groups: groups?.kind === 'answered' ? groups.value : null }
  },
  staleTime: 60_000,
  gcTime: 30 * 60_000,
  refetchOnWindowFocus: true,
  signal: { events: ['reposChanged'] },
  persist: {
    version: 1,
    dataSchema: z.object({
      sections: ProjectSectionCatalogSchema.nullable(),
      groups: z
        .array(z.custom<ProjectGroup>((group) => typeof group === 'object' && group !== null))
        .nullable()
    })
  }
})

// The Project catalog, read apart from repo labels so a slow or missing reply holds nothing back.
export function useHostProjectSections(args: {
  client: RpcClient | null
  hostId: string | undefined
  state: Pick<HostScreenState, 'setServedProjectSections' | 'setHostProjectGroups'>
  subscribed: boolean
  // The sidebar feed supplies the catalog with the rows.
  feedCarriesCatalog: boolean
}): void {
  const { client, hostId, state, subscribed, feedCarriesCatalog } = args
  const { setServedProjectSections, setHostProjectGroups } = state
  const { data, dataUpdatedAt } = useHostQuery(
    hostProjectSectionsQuery,
    { hostId: hostId ?? '', client },
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    { enabled: !!hostId && !feedCarriesCatalog, subscribed, refetchInterval: 60_000 }
  )
  useEffect(() => {
    if (!data) {
      return
    }
    setServedProjectSections(data.sections)
    if (data.groups) {
      setHostProjectGroups(data.groups)
    }
  }, [data, dataUpdatedAt, setServedProjectSections, setHostProjectGroups])
}
