export const RUN_MAILBOX_PREFIX = 'run:'
export const DISPATCH_MAILBOX_PREFIX = 'dispatch:'

/** Shared Run/Dispatch mailboxes, as opposed to a direct terminal handle. */
export function isOrchestrationMailboxAddress(handle: string): boolean {
  return handle.startsWith(RUN_MAILBOX_PREFIX) || handle.startsWith(DISPATCH_MAILBOX_PREFIX)
}
