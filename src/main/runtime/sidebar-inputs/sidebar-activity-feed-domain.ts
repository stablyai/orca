import type { SidebarInputsFeedDomain } from './sidebar-inputs-feed'

import { buildPairedServerActivityFacts } from '../../../shared/sidebar-list/paired-server-activity-facts'
import type { PairedServerRowsSnapshot } from '../../../shared/sidebar-list/paired-server-rows'
import type { WorkspaceActivityFacts } from '../../../shared/sidebar-list/workspace-activity-facts'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { keyWorkspaceActivityByRow } from '../../../shared/sidebar-list/workspace-activity-facts'
import type { SidebarInputsFeedSources } from './sidebar-inputs-feed-domains'
export function sidebarActivityFeedDomain(
  sources: SidebarInputsFeedSources
): SidebarInputsFeedDomain {
  const { facts, pairedServerRows, workspaceRows } = sources
  type PairedActivityRow = {
    server: PairedServerRowsSnapshot['servers'][number]
    row: PairedServerRowsSnapshot['servers'][number]['rows'][number]
  }
  const localActivityRows = new Map<string, string>()
  const localActivityKeys = new Map<string, Set<string>>()
  const pairedActivityRows = new Map<string, PairedActivityRow>()
  const pairedActivityKeys = new Map<string, Set<string>>()
  const activityKey = (hostId: string, owner: string): string => JSON.stringify([hostId, owner])
  const addActivityKey = (index: Map<string, Set<string>>, owner: string, key: string): void => {
    const keys = index.get(owner) ?? new Set<string>()
    keys.add(key)
    index.set(owner, keys)
  }

  return {
    name: 'activity',
    read: () => {
      const rows = workspaceRows.snapshot()?.rows
      if (!rows) {
        return null
      }
      localActivityRows.clear()
      localActivityKeys.clear()
      pairedActivityRows.clear()
      pairedActivityKeys.clear()
      for (const [key, row] of Object.entries(rows)) {
        localActivityRows.set(key, row.id)
        addActivityKey(localActivityKeys, row.id, key)
      }
      const servers = pairedServerRows.snapshot().servers
      for (const server of servers) {
        for (const row of server.rows) {
          pairedActivityRows.set(row.key, { server, row })
          addActivityKey(pairedActivityKeys, activityKey(server.hostId, row.worktreeId), row.key)
        }
      }
      return {
        // This host's session tabs and agents are by bare id, so a same-id pair it lists share them.
        ...keyWorkspaceActivityByRow(facts.getWorkspaceActivityFacts().facts, rows),
        ...buildPairedServerActivityFacts(
          servers,
          (hostId) => sources.store()?.getWorkspaceSession?.(hostId) ?? null
        )
      }
    },
    readEntities: (keys) => {
      const selected: Record<string, WorkspaceActivityFacts> = {}
      for (const key of keys) {
        const localId = localActivityRows.get(key)
        const local = localId && facts.workspaceActivityFacts.read(localId)
        if (local) {
          selected[key] = local
        }
        const paired = pairedActivityRows.get(key)
        if (paired) {
          Object.assign(
            selected,
            buildPairedServerActivityFacts([{ ...paired.server, rows: [paired.row] }], (hostId) => {
              const projection = sources
                .store()
                ?.readWorkspaceSessionUnits?.([paired.row.worktreeId], hostId)
              return projection
                ? {
                    browserTabsByWorktree: projection.reader.map(
                      'browserTabsByWorktree',
                      projection.owners
                    ),
                    unifiedTabs: projection.reader.map('unifiedTabs', projection.owners)
                  }
                : null
            })
          )
        }
      }
      return selected
    },
    ready: () => workspaceRows.ready(),
    watch: (changed) => {
      const detaches = [
        facts.workspaceActivityFacts.revision.onChange((change) => {
          if (!change.entities) {
            changed(change)
          } else {
            changed({
              ...change,
              entities: change.entities.flatMap((id) => [...(localActivityKeys.get(id) ?? [])])
            })
          }
        }),
        workspaceRows.revision.onChange(changed),
        pairedServerRows.revision.onChange(changed),
        // This desktop's saved session for a paired server holds its browser and chat tabs there.
        sources.store()?.onWorkspaceSessionWritten?.((hostId, partitions) => {
          for (const changes of partitions ?? [undefined]) {
            const host = changes?.hostId ?? hostId
            if (host !== null && parseExecutionHostId(host)?.kind !== 'runtime') {
              continue
            }
            if (!changes || changes.fullReplacement) {
              changed()
            } else if (
              changes.units.some(
                (unit) => unit.field === 'browserTabsByWorktree' || unit.field === 'unifiedTabs'
              )
            ) {
              changed({
                entities: [...changes.owners].flatMap((owner) => [
                  ...(pairedActivityKeys.get(activityKey(changes.hostId, owner)) ?? [])
                ])
              })
            }
          }
        })
      ]
      return () => detaches.forEach((detach) => detach?.())
    }
  }
}
