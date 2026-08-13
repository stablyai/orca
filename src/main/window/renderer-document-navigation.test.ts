import { describe, expect, it, vi } from 'vitest'
import { registerRendererDocumentNavigation } from './renderer-document-navigation'

describe('renderer document navigation', () => {
  function createFixture(currentUrl: string) {
    const on = vi.fn()
    const onStarted = vi.fn()
    registerRendererDocumentNavigation({ getURL: () => currentUrl, on } as never, onStarted)
    const navigate = on.mock.calls[0]?.[1]
    return { navigate, onStarted }
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
})
