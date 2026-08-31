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

  // A client-hosted guest is registered by main's host runtime with no workspace, so its forwarded
  // chord can only name the page.
  it('dispatches a page-only target to every workspace holding that page', () => {
    const subscriptions = createBrowserFindSubscriptions()
    const firstCallback = vi.fn()
    const sameWorkspaceCallback = vi.fn()
    const samePageCallback = vi.fn()
    subscriptions.subscribe(FIRST_SOURCE, firstCallback)
    subscriptions.subscribe(SAME_WORKSPACE_SOURCE, sameWorkspaceCallback)
    subscriptions.subscribe(SAME_PAGE_SOURCE, samePageCallback)

    subscriptions.dispatch({ browserPageId: FIRST_SOURCE.browserPageId })

    expect(firstCallback).toHaveBeenCalledOnce()
    expect(samePageCallback).toHaveBeenCalledOnce()
    expect(sameWorkspaceCallback).not.toHaveBeenCalled()
  })

  it('dispatches an explicitly undefined workspace as page-only, not as a miss', () => {
    const subscriptions = createBrowserFindSubscriptions()
    const callback = vi.fn()
    subscriptions.subscribe(FIRST_SOURCE, callback)

    // Structured-clone IPC preserves an explicitly-undefined property, so main's optional field
    // arrives as a present key rather than an absent one.
    subscriptions.dispatch({
      browserPageId: FIRST_SOURCE.browserPageId,
      browserWorkspaceId: undefined
    })

    expect(callback).toHaveBeenCalledOnce()
  })

  it('rejects malformed identities and blank ids', () => {
    const subscriptions = createBrowserFindSubscriptions()
    const callback = vi.fn()
    subscriptions.subscribe(FIRST_SOURCE, callback)

    subscriptions.dispatch(undefined)
    subscriptions.dispatch(['page-1'])
    subscriptions.dispatch({ browserWorkspaceId: FIRST_SOURCE.browserWorkspaceId })
    subscriptions.dispatch({ browserPageId: '' })
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
    expect(subscriptions.subscribedPageCount()).toBe(1)

    unsubscribe()

    subscriptions.dispatch(FIRST_SOURCE)
    subscriptions.dispatch({ browserPageId: FIRST_SOURCE.browserPageId })
    expect(callback).not.toHaveBeenCalled()
    // Not just silent — the entry is gone, so a long session cannot accumulate empty maps.
    expect(subscriptions.subscribedPageCount()).toBe(0)
  })

  // Why: the page entry is shared, so pruning it on one workspace's cleanup would silently
  // unsubscribe its siblings.
  it('keeps the other workspaces on a page when one of them unsubscribes', () => {
    const subscriptions = createBrowserFindSubscriptions()
    const firstCallback = vi.fn()
    const samePageCallback = vi.fn()
    const unsubscribe = subscriptions.subscribe(FIRST_SOURCE, firstCallback)
    subscriptions.subscribe(SAME_PAGE_SOURCE, samePageCallback)

    unsubscribe()
    subscriptions.dispatch(SAME_PAGE_SOURCE)
    subscriptions.dispatch({ browserPageId: FIRST_SOURCE.browserPageId })

    expect(firstCallback).not.toHaveBeenCalled()
    expect(samePageCallback).toHaveBeenCalledTimes(2)
    expect(subscriptions.subscribedPageCount()).toBe(1)
  })
})
