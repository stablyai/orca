import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { MobileWebTaskProjectTableSchema } from '../../../src/shared/mobile-web/task-project-table-contract'
import type { HostTaskProjectReadOperations } from './host-task-project-read-operations'

export function webHostTaskProjectReadOperations(
  client: MobileWebBridgeClient
): HostTaskProjectReadOperations {
  return {
    listAccessible: (host) => client.task.listProjects({ host }),
    async listViews(project) {
      return (await client.task.listProjectViews(project)).views
    },
    resolveRef: (payload) => client.task.resolveProjectRef(payload),
    async loadTable(payload) {
      const first = await client.task.projectTablePage(payload)
      if (!first.project || !first.selectedView || first.totalCount === undefined) {
        throw new Error('Project table metadata is unavailable')
      }
      const rows = [...first.rows]
      let cursor = first.nextCursor
      while (cursor) {
        const next = await client.task.projectTablePage({ ...payload, cursor })
        rows.push(...next.rows)
        cursor = next.nextCursor
      }
      return MobileWebTaskProjectTableSchema.parse({
        project: first.project,
        selectedView: first.selectedView,
        totalCount: first.totalCount,
        parentFieldDropped: first.parentFieldDropped,
        rows
      })
    },
    loadItemDetail: (payload) => client.task.loadProjectItemDetail(payload),
    async listItemLabels(payload) {
      return (await client.task.listProjectItemLabels(payload)).labels
    },
    async listItemAssignableUsers(payload) {
      return (await client.task.listProjectItemAssignableUsers(payload)).users
    },
    async listIssueTypes(payload) {
      return (await client.task.listProjectIssueTypes(payload)).types
    }
  }
}
