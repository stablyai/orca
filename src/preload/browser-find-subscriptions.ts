import { asBrowserFindTarget, type BrowserFindSource } from '../shared/browser-find-source'

type BrowserFindCallback = () => void

export function createBrowserFindSubscriptions(): {
  dispatch: (target: unknown) => void
  subscribe: (source: BrowserFindSource, callback: BrowserFindCallback) => () => void
  /** Pages currently holding subscribers. This registry outlives every pane, so a cleanup that
   * leaves entries behind grows without bound over a session. */
  subscribedPageCount: () => number
} {
  // Why: page first, workspace second — a target that names only the page must still reach the one
  // pane that owns it, while active splits sharing this renderer stay separable by workspace.
  const callbacksByPage = new Map<string, Map<string, Set<BrowserFindCallback>>>()

  return {
    subscribedPageCount: () => callbacksByPage.size,
    dispatch: (target) => {
      const findTarget = asBrowserFindTarget(target)
      if (!findTarget) {
        return
      }
      const callbacksByWorkspace = callbacksByPage.get(findTarget.browserPageId)
      if (!callbacksByWorkspace) {
        return
      }
      const scoped =
        findTarget.browserWorkspaceId === undefined
          ? [...callbacksByWorkspace.values()]
          : [callbacksByWorkspace.get(findTarget.browserWorkspaceId)]
      for (const callbacks of scoped) {
        for (const callback of callbacks ?? []) {
          callback()
        }
      }
    },
    subscribe: (source, callback) => {
      let callbacksByWorkspace = callbacksByPage.get(source.browserPageId)
      if (!callbacksByWorkspace) {
        callbacksByWorkspace = new Map()
        callbacksByPage.set(source.browserPageId, callbacksByWorkspace)
      }
      let callbacks = callbacksByWorkspace.get(source.browserWorkspaceId)
      if (!callbacks) {
        callbacks = new Set()
        callbacksByWorkspace.set(source.browserWorkspaceId, callbacks)
      }
      callbacks.add(callback)

      return () => {
        callbacks.delete(callback)
        if (callbacks.size > 0) {
          return
        }
        callbacksByWorkspace.delete(source.browserWorkspaceId)
        if (callbacksByWorkspace.size === 0) {
          callbacksByPage.delete(source.browserPageId)
        }
      }
    }
  }
}
