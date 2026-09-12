const COLLABORATION_TASK_MAILBOX_PREFIX = 'collaboration-task:'

export function buildCollaborationTaskMailboxAddress(taskId: string): string {
  if (taskId.length === 0 || taskId.trim().length === 0) {
    throw new Error('taskId must be non-empty')
  }
  return `${COLLABORATION_TASK_MAILBOX_PREFIX}${taskId}`
}

export function parseCollaborationTaskMailboxAddress(address: string): string | null {
  if (!address.startsWith(COLLABORATION_TASK_MAILBOX_PREFIX)) {
    return null
  }
  const taskId = address.slice(COLLABORATION_TASK_MAILBOX_PREFIX.length)
  return taskId.length === 0 ? null : taskId
}
