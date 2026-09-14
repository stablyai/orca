import { describe, expect, it, vi } from 'vitest'
import { registerRendererDocumentNavigation } from './renderer-document-navigation'

describe('renderer document navigation', () => {
  function createFixture(currentUrl: string, onStarted = vi.fn(() => vi.fn())) {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    let loadingMainFrame = false
    const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
    })
    registerRendererDocumentNavigation(
      { getURL: () => currentUrl, isLoadingMainFrame: () => loadingMainFrame, on } as never,
      onStarted
    )
    return {
      navigate: handlers.get('did-start-navigation'),
      failProvisionalLoad: handlers.get('did-fail-provisional-load'),
      willNavigate: handlers.get('will-navigate'),
      commitNavigation: handlers.get('did-frame-navigate'),
      stopLoading: handlers.get('did-stop-loading'),
      onStarted,
      setLoadingMainFrame(value: boolean) {
        loadingMainFrame = value
      }
    }
  }

  it('accepts the packaged renderer document but not a blocked external load', () => {
    const fixture = createFixture('file:///opt/orca/renderer/index.html')

    fixture.navigate?.({}, 'https://github.com/stablyai/orca/issues', false, true)
    expect(fixture.onStarted).not.toHaveBeenCalled()
    fixture.navigate?.({}, 'file:///opt/orca/renderer/index.html?reload=1', false, true)
    expect(fixture.onStarted).toHaveBeenCalledOnce()
  })

  it('accepts same-origin development navigation only', () => {
    const fixture = createFixture('http://localhost:5173/')

    fixture.navigate?.({}, 'https://example.com/', false, true)
    fixture.navigate?.({}, 'http://localhost:5173/settings', false, true)
    expect(fixture.onStarted).toHaveBeenCalledOnce()
  })

  it('rejects same-document, subframe, and missing renderer navigation', () => {
    const fixture = createFixture('')

    fixture.navigate?.({}, 'http://localhost:5173/', false, true)
    fixture.navigate?.({}, 'http://localhost:5173/', true, true)
    fixture.navigate?.({}, 'http://localhost:5173/', false, false)
    expect(fixture.onStarted).not.toHaveBeenCalled()
  })

  it('cancels only the matching main-frame provisional navigation', async () => {
    const cancel = vi.fn()
    const fixture = createFixture(
      'http://localhost:5173/',
      vi.fn(() => cancel)
    )

    fixture.navigate?.({}, 'http://localhost:5173/reload', false, true)
    fixture.failProvisionalLoad?.({}, -3, 'aborted', 'other', true, 1, 1)
    fixture.failProvisionalLoad?.({}, -3, 'aborted', 'http://localhost:5173/reload', false, 1, 1)
    expect(cancel).not.toHaveBeenCalled()

    fixture.failProvisionalLoad?.({}, -3, 'aborted', 'http://localhost:5173/reload', true, 1, 1)
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('shares one reload fence across concurrent provisional navigations', async () => {
    const cancel = vi.fn()
    const onStarted = vi.fn(() => cancel)
    const fixture = createFixture('http://localhost:5173/', onStarted)

    fixture.navigate?.({}, 'http://localhost:5173/reload-a', false, true)
    fixture.navigate?.({}, 'http://localhost:5173/reload-b', false, true)

    expect(onStarted).toHaveBeenCalledOnce()
    fixture.setLoadingMainFrame(true)
    fixture.failProvisionalLoad?.({}, -3, 'aborted', 'http://localhost:5173/reload-a', true, 1, 1)
    await Promise.resolve()
    expect(cancel).not.toHaveBeenCalled()
    fixture.setLoadingMainFrame(false)
    fixture.failProvisionalLoad?.({}, -3, 'aborted', 'http://localhost:5173/reload-b', true, 1, 1)
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('restores an idle surviving document after loading stops', async () => {
    const cancel = vi.fn()
    const fixture = createFixture(
      'http://localhost:5173/',
      vi.fn(() => cancel)
    )

    fixture.navigate?.({}, 'http://localhost:5173/reload', false, true)
    fixture.setLoadingMainFrame(true)
    fixture.failProvisionalLoad?.({}, -3, 'aborted', 'http://localhost:5173/reload', true, 1, 1)
    await Promise.resolve()
    expect(cancel).not.toHaveBeenCalled()

    fixture.setLoadingMainFrame(false)
    fixture.stopLoading?.()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('restores after a concurrent failure and blocked replacement both settle', async () => {
    const cancel = vi.fn()
    const fixture = createFixture(
      'http://localhost:5173/',
      vi.fn(() => cancel)
    )
    const event = { defaultPrevented: false }

    fixture.navigate?.({}, 'http://localhost:5173/reload-a', false, true)
    fixture.navigate?.({}, 'http://localhost:5173/reload-b', false, true)
    fixture.setLoadingMainFrame(true)
    fixture.failProvisionalLoad?.({}, -3, 'aborted', 'http://localhost:5173/reload-a', true)
    await Promise.resolve()
    expect(cancel).not.toHaveBeenCalled()

    fixture.willNavigate?.(event, 'http://localhost:5173/reload-b', false, true)
    event.defaultPrevented = true
    fixture.setLoadingMainFrame(false)
    await Promise.resolve()

    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not cancel a navigation after its document commits', () => {
    const cancel = vi.fn()
    const fixture = createFixture(
      'file:///opt/orca/renderer/index.html',
      vi.fn(() => cancel)
    )

    fixture.navigate?.({}, 'file:///opt/orca/renderer/index.html?reload=1', false, true)
    fixture.commitNavigation?.(
      {},
      'file:///opt/orca/renderer/index.html?reload=1',
      -1,
      '',
      true,
      1,
      1
    )
    fixture.failProvisionalLoad?.(
      {},
      -3,
      'aborted',
      'file:///opt/orca/renderer/index.html?reload=1',
      true,
      1,
      1
    )

    expect(cancel).not.toHaveBeenCalled()
  })

  it('does not let a stale same-URL failure cancel a replacement navigation', async () => {
    const cancels: ReturnType<typeof vi.fn>[] = []
    const fixture = createFixture(
      'http://localhost:5173/',
      vi.fn(() => {
        const cancel = vi.fn()
        cancels.push(cancel)
        return cancel
      })
    )
    const url = 'http://localhost:5173/reload'

    fixture.navigate?.({}, url, false, true)
    fixture.commitNavigation?.({}, url, -1, '', true, 1, 1)
    fixture.navigate?.({}, url, false, true)
    fixture.setLoadingMainFrame(true)
    fixture.failProvisionalLoad?.({}, -3, 'aborted', url, true, 1, 1)
    await Promise.resolve()

    expect(cancels).toHaveLength(2)
    expect(cancels[1]).not.toHaveBeenCalled()

    fixture.setLoadingMainFrame(false)
    fixture.failProvisionalLoad?.({}, -3, 'aborted', url, true, 1, 1)
    await Promise.resolve()
    expect(cancels[1]).toHaveBeenCalledOnce()
  })

  it('cancels when a later will-navigate listener blocks the navigation', async () => {
    const cancel = vi.fn()
    const fixture = createFixture(
      'http://localhost:5173/',
      vi.fn(() => cancel)
    )
    const event = { defaultPrevented: false }

    fixture.navigate?.({}, 'http://localhost:5173/reload', false, true)
    fixture.willNavigate?.(event, 'http://localhost:5173/reload', false, true, 1, 1)
    event.defaultPrevented = true
    await Promise.resolve()

    expect(cancel).toHaveBeenCalledOnce()
  })
})
