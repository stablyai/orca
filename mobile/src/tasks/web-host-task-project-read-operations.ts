import {
  MobileWebTaskProjectTableSchema,
  type MobileWebTaskProjectTable,
  type MobileWebTaskProjectTablePayload
} from '../../../src/shared/mobile-web/task-project-table-contract'
import type { HostTaskProjectReadOperations } from './host-task-project-read-operations'
import {
  nativeHostTaskProjectReadOperations,
  projectResult
} from './native-host-task-project-read-operations'
import type { RpcRequestSender } from '../transport/rpc-client'

type ProjectTableWindow = {
  data: MobileWebTaskProjectTable
  nextRowOffset?: number
}

/** Same reads as the native app, except the table arrives one row window at a time because the
 * whole table can exceed the bridge envelope. */
export function webHostTaskProjectReadOperations(
  client: RpcRequestSender
): HostTaskProjectReadOperations {
  return {
    ...nativeHostTaskProjectReadOperations(client),
    loadTable: (payload) => loadWindowedTable(client, payload)
  }
}

async function loadWindowedTable(
  client: RpcRequestSender,
  payload: Omit<MobileWebTaskProjectTablePayload, 'cursor'>
): Promise<MobileWebTaskProjectTable> {
  const rows: MobileWebTaskProjectTable['rows'] = []
  let table: MobileWebTaskProjectTable | null = null
  let rowOffset: number | undefined = 0
  while (rowOffset !== undefined) {
    const page: ProjectTableWindow = await projectResult<ProjectTableWindow>(
      client.sendRequest(
        'mobileWeb.tasks.projectTable',
        {
          owner: payload.owner,
          host: payload.host,
          ownerType: payload.ownerType,
          projectNumber: payload.number,
          viewId: payload.viewId,
          queryOverride: payload.queryOverride,
          rowOffset
        },
        { timeoutMs: 60_000 }
      )
    )
    table = page.data
    rows.push(...page.data.rows)
    // A window that added nothing cannot be followed by one that does, so stop rather than spin.
    rowOffset = page.data.rows.length > 0 ? page.nextRowOffset : undefined
  }
  return MobileWebTaskProjectTableSchema.parse({ ...table, rows })
}
