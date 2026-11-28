import type { TabListRef } from '../../../bots/team-share/teammate-rules'

/** Collect synchronous admission output, once per list; later real transitions publish immediately. */
export function batchBrowserPageInitializationNotifications<T>(
  notify: (page: TabListRef) => void,
  admit: (notify: (page: TabListRef) => void) => T
): T {
  let collecting = true
  const lists = new Map<string, TabListRef>()
  const changed = (page: TabListRef): void => {
    if (collecting) {
      lists.set(`${page.holder ?? 'host'}\0${page.workspaceId}`, page)
    } else {
      notify(page)
    }
  }
  try {
    return admit(changed)
  } finally {
    collecting = false
    const pending = [...lists.values()]
    lists.clear()
    for (const page of pending) {
      notify(page)
    }
  }
}
