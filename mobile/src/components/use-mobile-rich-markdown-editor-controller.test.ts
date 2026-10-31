import { describe, expect, it, vi } from 'vitest'
import { openEditorLink } from './use-mobile-rich-markdown-editor-controller'

describe('rich Markdown editor links', () => {
  it.each([
    ['https://example.com/a', [['https://example.com/a']], []],
    ['mailto:team@example.com', [['mailto:team@example.com']], []],
    ['images/photo.png', [], [['images/photo.png']]],
    ['javascript:alert(1)', [], []]
  ])('routes %s to the matching handler', (href, webCalls, workspaceCalls) => {
    const onOpenLink = vi.fn()
    const onOpenWorkspaceFile = vi.fn()
    openEditorLink(href, onOpenLink, onOpenWorkspaceFile)
    expect(onOpenLink.mock.calls).toEqual(webCalls)
    expect(onOpenWorkspaceFile.mock.calls).toEqual(workspaceCalls)
  })

  it('keeps workspace links inert when the caller does not handle them', () => {
    const onOpenLink = vi.fn()
    openEditorLink('images/photo.png', onOpenLink)
    expect(onOpenLink).not.toHaveBeenCalled()
  })
})
