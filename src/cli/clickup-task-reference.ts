const CLICKUP_TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function parseClickUpTaskReference(value: string): string | null {
  const input = value.trim()
  try {
    const url = new URL(input)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'app.clickup.com' ||
      url.port ||
      url.username ||
      url.password
    ) {
      return null
    }
    const match = /^\/t\/([^/]+)(?:\/.*)?$/.exec(url.pathname)
    const taskId = match?.[1] ? decodeURIComponent(match[1]) : ''
    return CLICKUP_TASK_ID_PATTERN.test(taskId) ? taskId : null
  } catch {
    return CLICKUP_TASK_ID_PATTERN.test(input) ? input : null
  }
}
