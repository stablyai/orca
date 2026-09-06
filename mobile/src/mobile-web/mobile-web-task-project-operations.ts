import {
  MobileWebTaskProjectListPayloadSchema,
  MobileWebTaskProjectListResultSchema,
  MobileWebTaskProjectResolvePayloadSchema,
  MobileWebTaskProjectResolveResultSchema,
  MobileWebTaskProjectViewsPayloadSchema,
  MobileWebTaskProjectViewsResultSchema
} from '../../../src/shared/mobile-web/task-project-read-contract'
import {
  MobileWebTaskProjectAssignableUsersPayloadSchema,
  MobileWebTaskProjectAssignableUsersResultSchema,
  MobileWebTaskProjectIssueTypesResultSchema,
  MobileWebTaskProjectItemDetailPayloadSchema,
  MobileWebTaskProjectItemDetailResultSchema,
  MobileWebTaskProjectLabelsResultSchema,
  MobileWebTaskProjectSlugPayloadSchema
} from '../../../src/shared/mobile-web/task-project-metadata-contract'
import {
  MobileWebTaskProjectTablePageResultSchema,
  MobileWebTaskProjectTablePayloadSchema
} from '../../../src/shared/mobile-web/task-project-table-contract'
import { nativeHostTaskProjectReadOperations } from '../tasks/native-host-task-project-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebTaskProjectTablePager } from './mobile-web-task-project-table-pager'
import type { MobileWebTaskTargetAuthority } from './mobile-web-task-target-authority'

export async function executeMobileWebTaskProjectOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  table: MobileWebTaskProjectTablePager
  targetAuthority: MobileWebTaskTargetAuthority
}): Promise<unknown> {
  const operations = nativeHostTaskProjectReadOperations(args.client)
  if (args.operation === 'projectTable') {
    const payload = MobileWebTaskProjectTablePayloadSchema.parse(args.payload)
    const page = await args.table.page(payload, (request) => operations.loadTable(request))
    return MobileWebTaskProjectTablePageResultSchema.parse({
      ...page,
      rows: page.rows.map((row) => ({
        ...row,
        targetId: args.targetAuthority.registerGitHubProject({
          owner: payload.owner,
          host: payload.host ?? 'github.com',
          ownerType: payload.ownerType,
          projectNumber: payload.number,
          viewId: payload.viewId,
          ...(payload.queryOverride !== undefined ? { queryOverride: payload.queryOverride } : {}),
          rowId: row.id,
          itemType: row.itemType,
          repository: row.content.repository,
          number: row.content.number
        })
      }))
    })
  }
  if (args.operation === 'listProjects') {
    const payload = MobileWebTaskProjectListPayloadSchema.parse(args.payload)
    return MobileWebTaskProjectListResultSchema.parse(await operations.listAccessible(payload.host))
  }
  if (args.operation === 'listProjectViews') {
    const payload = MobileWebTaskProjectViewsPayloadSchema.parse(args.payload)
    return MobileWebTaskProjectViewsResultSchema.parse({
      views: await operations.listViews(payload)
    })
  }
  if (args.operation === 'resolveProjectRef') {
    const payload = MobileWebTaskProjectResolvePayloadSchema.parse(args.payload)
    return MobileWebTaskProjectResolveResultSchema.parse(await operations.resolveRef(payload))
  }
  if (args.operation === 'projectItemDetail') {
    const payload = MobileWebTaskProjectItemDetailPayloadSchema.parse(args.payload)
    return MobileWebTaskProjectItemDetailResultSchema.parse(
      await operations.loadItemDetail(payload)
    )
  }
  if (args.operation === 'projectItemLabels') {
    const payload = MobileWebTaskProjectSlugPayloadSchema.parse(args.payload)
    return MobileWebTaskProjectLabelsResultSchema.parse({
      labels: await operations.listItemLabels(payload)
    })
  }
  if (args.operation === 'projectItemAssignableUsers') {
    const payload = MobileWebTaskProjectAssignableUsersPayloadSchema.parse(args.payload)
    return MobileWebTaskProjectAssignableUsersResultSchema.parse({
      users: await operations.listItemAssignableUsers(payload)
    })
  }
  if (args.operation === 'projectIssueTypes') {
    const payload = MobileWebTaskProjectSlugPayloadSchema.parse(args.payload)
    return MobileWebTaskProjectIssueTypesResultSchema.parse({
      types: await operations.listIssueTypes(payload)
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}
