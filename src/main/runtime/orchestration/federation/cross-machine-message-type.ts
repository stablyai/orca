import type { MessageType } from '../db/orchestration-records'

/** Another Orca may predate `notice`; it is delivered there exactly as status is, so it crosses as status. */
export function crossMachineMessageType(type: MessageType): Exclude<MessageType, 'notice'> {
  return type === 'notice' ? 'status' : type
}

export function crossMachineMessageTypeSql(column: string): string {
  return `CASE ${column} WHEN 'notice' THEN 'status' ELSE ${column} END`
}
