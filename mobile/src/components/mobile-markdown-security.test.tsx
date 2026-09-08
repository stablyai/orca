import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'

vi.mock('react-native', () => ({
  Fragment: 'Fragment',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View'
}))

vi.mock('./mobile-markdown-styles', () => ({
  styles: new Proxy(
    {},
    {
      get: (_target, key) => String(key)
    }
  )
}))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))

describe('MobileMarkdown security', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.restoreAllMocks()
  })

  it('keeps HTML/SVG inert and admits only HTTP(S)/mailto link taps', async () => {
    const onOpenLink = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      renderer = create(
        createElement(MobileMarkdown, {
          content: [
            '<script>globalThis.pwned=true</script>',
            '<iframe src="https://sentinel.invalid/frame"></iframe>',
            '<svg onload="globalThis.pwned=true"><foreignObject>bad</foreignObject></svg>',
            '<img src="https://sentinel.invalid/image" onerror="globalThis.pwned=true">',
            '[safe](https://example.com/path)',
            '[http](http://example.com/path)',
            '[script](javascript:alert(1))',
            '[data](data:text/html,bad)',
            '[mail](mailto:security@example.com)'
          ].join('\n\n'),
          onOpenLink
        })
      )
    })
    consoleError.mockRestore()

    const renderedTypes = new Set(renderer!.root.findAll(() => true).map((node) => node.type))
    expect(renderedTypes.has('script')).toBe(false)
    expect(renderedTypes.has('iframe')).toBe(false)
    expect(renderedTypes.has('svg')).toBe(false)
    expect(renderedTypes.has('img')).toBe(false)

    for (const node of renderer!.root.findAll((candidate) => Boolean(candidate.props.onPress))) {
      await act(async () => node.props.onPress())
    }
    // mailto joins http(s): the OS mail handler owns it, javascript:/data: stay refused.
    expect(onOpenLink.mock.calls).toEqual([
      ['https://example.com/path'],
      ['http://example.com/path'],
      ['mailto:security@example.com']
    ])
  })
})
