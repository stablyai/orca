import { parseOrcaSessionAddress } from '../../../../../shared/orca-session-address'

/** One active Dispatch per assignee; a chat is named by its Orca session ID, never as a terminal. */
export function assigneeActiveDispatchRefusal(
  assigneeHandle: string,
  existing: { id: string; task_id: string }
): Error {
  const assignee = parseOrcaSessionAddress(assigneeHandle)
    ? assigneeHandle
    : `Terminal ${assigneeHandle}`
  return new Error(
    `${assignee} already has an active dispatch (${existing.id} for task ${existing.task_id})`
  )
}
