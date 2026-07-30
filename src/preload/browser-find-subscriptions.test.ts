import { describe, expect, it, vi } from 'vitest'
import { createBrowserFindSubscriptions } from './browser-find-subscriptions'

const FIRST_SOURCE = {
  browserPageId: 'page-1',
  browserWorkspaceId: 'workspace-1'
}
const SAME_WORKSPACE_SOURCE = {
  browserPageId: 'page-2',
  browserWorkspaceId: FIRST_SOURCE.browserWorkspaceId
}
const SAME_PAGE_SOURCE = {
  browserPageId: FIRST_SOURCE.browserPageId,
  browserWorkspaceId: 'workspace-2'
}

describe('browser Find subscriptions', () => {
  it('dispatches only to the exact browser page and workspace owner', () => {
    const subscriptions = createBrowserFindSubscriptions()
    const firstCallback = vi.fn()
    const sameWorkspaceCallback = vi.fn()
    const samePageCallback = vi.fn()
    subscriptions.subscribe(FIRST_SOURCE, firstCallback)
    subscriptions.subscribe(SAME_WORKSPACE_SOURCE, sameWorkspaceCallback)
    subscriptions.subscribe(SAME_PAGE_SOURCE, samePageCallback)

    subscriptions.dispatch(FIRST_SOURCE)

    expect(firstCallback).toHaveBeenCalledOnce()
    expect(sameWorkspaceCallback).not.toHaveBeenCalled()
    expect(samePageCallback).not.toHaveBeenCalled()
  })

  it('rejects malformed and partial source identities', () => {
    const subscriptions = createBrowserFindSubscriptions()
    const callback = vi.fn()
    subscriptions.subscribe(FIRST_SOURCE, callback)

    subscriptions.dispatch(undefined)
    subscriptions.dispatch({ browserPageId: FIRST_SOURCE.browserPageId })
    subscriptions.dispatch({
      browserPageId: FIRST_SOURCE.browserPageId,
      browserWorkspaceId: ''
    })

    expect(callback).not.toHaveBeenCalled()
  })

  it('drops empty ownership entries when subscribers clean up', () => {
    const subscriptions = createBrowserFindSubscriptions()
    const callback = vi.fn()
    const unsubscribe = subscriptions.subscribe(FIRST_SOURCE, callback)

    unsubscribe()
    subscriptions.dispatch(FIRST_SOURCE)

    expect(callback).not.toHaveBeenCalled()
  })
})
