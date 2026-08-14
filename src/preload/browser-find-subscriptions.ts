import { isBrowserFindSource, type BrowserFindSource } from '../shared/browser-find-source'

type BrowserFindCallback = () => void

export function createBrowserFindSubscriptions(): {
  dispatch: (source: unknown) => void
  subscribe: (source: BrowserFindSource, callback: BrowserFindCallback) => () => void
} {
  const callbacksByWorkspace = new Map<string, Map<string, Set<BrowserFindCallback>>>()

  return {
    dispatch: (source) => {
      if (!isBrowserFindSource(source)) {
        return
      }
      const callbacks = callbacksByWorkspace
        .get(source.browserWorkspaceId)
        ?.get(source.browserPageId)
      if (!callbacks) {
        return
      }
      for (const callback of callbacks) {
        callback()
      }
    },
    subscribe: (source, callback) => {
      let callbacksByPage = callbacksByWorkspace.get(source.browserWorkspaceId)
      if (!callbacksByPage) {
        callbacksByPage = new Map()
        callbacksByWorkspace.set(source.browserWorkspaceId, callbacksByPage)
      }
      let callbacks = callbacksByPage.get(source.browserPageId)
      if (!callbacks) {
        callbacks = new Set()
        callbacksByPage.set(source.browserPageId, callbacks)
      }
      callbacks.add(callback)

      return () => {
        callbacks.delete(callback)
        if (callbacks.size > 0) {
          return
        }
        callbacksByPage.delete(source.browserPageId)
        if (callbacksByPage.size === 0) {
          callbacksByWorkspace.delete(source.browserWorkspaceId)
        }
      }
    }
  }
}
