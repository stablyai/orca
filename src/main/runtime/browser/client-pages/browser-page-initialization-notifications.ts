/** Collect synchronous admission output; later real transitions publish immediately. */
export function batchBrowserPageInitializationNotifications<T>(
  notify: (workspaceId: string) => void,
  admit: (notify: (workspaceId: string) => void) => T
): T {
  let collecting = true
  const workspaces = new Set<string>()
  const changed = (workspace: string): void => {
    if (collecting) {
      workspaces.add(workspace)
    } else {
      notify(workspace)
    }
  }
  try {
    return admit(changed)
  } finally {
    collecting = false
    const pending = [...workspaces]
    workspaces.clear()
    for (const workspace of pending) {
      notify(workspace)
    }
  }
}
