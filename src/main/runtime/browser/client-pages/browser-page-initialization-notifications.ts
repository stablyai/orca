import type { PageListRef } from './runtime-browser-page-registry'

/** Collect synchronous admission output, once per list; later real transitions publish immediately. */
export function batchBrowserPageInitializationNotifications<T>(
  notify: (page: PageListRef) => void,
  admit: (notify: (page: PageListRef) => void) => T
): T {
  let collecting = true
  const lists = new Map<string, PageListRef>()
  const changed = (page: PageListRef): void => {
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
