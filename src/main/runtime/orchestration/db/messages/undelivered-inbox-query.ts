import type { MessageType } from '../orchestration-records'
import { runOwnsDirectMessageSql } from '../runs/run-coordinator-mail-routing'

export type UndeliveredInboxOptions = {
  excludeTypes?: readonly string[]
  excludeIds?: readonly string[]
  excludeRunOwnedDirect?: boolean
  newestFirst?: boolean
  limit?: number
}

export function undeliveredInboxQuery(
  toHandle: string,
  types?: MessageType[],
  options?: UndeliveredInboxOptions
) {
  const conditions = [
    'to_handle = ?',
    'read = 0',
    'delivered_at IS NULL',
    'pointer_enter_pending = 0',
    "delivery_contract = 'current_delivery'",
    ...(options?.excludeRunOwnedDirect ? [`NOT ${runOwnsDirectMessageSql('messages')}`] : [])
  ]
  const params: (string | number)[] = [toHandle]
  if (types?.length) {
    conditions.push(`type IN (${types.map(() => '?').join(',')})`)
    params.push(...types)
  }
  if (options?.excludeTypes?.length) {
    conditions.push(`type NOT IN (${options.excludeTypes.map(() => '?').join(',')})`)
    params.push(...options.excludeTypes)
  }
  if (options?.excludeIds?.length) {
    conditions.push(`id NOT IN (${options.excludeIds.map(() => '?').join(',')})`)
    params.push(...options.excludeIds)
  }
  const limitSql = options?.limit === undefined ? '' : ' LIMIT ?'
  if (options?.limit !== undefined) {
    params.push(Math.max(1, Math.floor(options.limit)))
  }
  return {
    sql: `FROM messages WHERE ${conditions.join(' AND ')} ORDER BY sequence${options?.newestFirst ? ' DESC' : ''}${limitSql}`,
    params
  }
}
