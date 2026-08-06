import { createElement } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'

const openURL = vi.fn(() => Promise.resolve())

vi.mock('react-native', () => ({
  Linking: { openURL: (url: string) => openURL(url) },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))

function flattenText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : flattenText(child)))
    .join('')
}

function pressables(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => node.type === ('Text' as never) && typeof node.props.onPress === 'function'
  )
}

function pressByText(renderer: ReactTestRenderer, text: string): void {
  const target = pressables(renderer).find((node) => flattenText(node) === text)
  expect(target, `no pressable text ${JSON.stringify(text)}`).toBeDefined()
  target!.props.onPress()
}

describe('MobileMarkdown file links', () => {
  let renderer: ReactTestRenderer | null = null
  const onOpenFile = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    onOpenFile.mockClear()
    openURL.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(content: string): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileMarkdown, { content, onOpenFile }))
    })
    return renderer!
  }

  it('opens a tapped POSIX absolute path in prose', () => {
    pressByText(render('Edit /Users/me/wt/src/app.tsx now'), '/Users/me/wt/src/app.tsx')
    expect(onOpenFile).toHaveBeenCalledWith('/Users/me/wt/src/app.tsx')
  })

  it('opens a tapped path:line citation in prose', () => {
    pressByText(render('see src/foo.ts:42 for the fix'), 'src/foo.ts:42')
    expect(onOpenFile).toHaveBeenCalledWith('src/foo.ts:42')
  })

  it('routes a relative markdown href to the file opener with its #L line', () => {
    pressByText(render('read [the plan](docs/plan.md#L7) first'), 'the plan')
    expect(onOpenFile).toHaveBeenCalledWith('docs/plan.md:7')
    expect(openURL).not.toHaveBeenCalled()
  })

  it('routes a file: href to the file opener', () => {
    pressByText(render('[artifact](file:///tmp/out/result.json)'), 'artifact')
    expect(onOpenFile).toHaveBeenCalledWith('/tmp/out/result.json')
  })

  it('keeps web links on the system browser', () => {
    pressByText(render('go to [site](https://example.com/docs)'), 'site')
    expect(openURL).toHaveBeenCalledWith('https://example.com/docs')
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('drops unknown-scheme hrefs without opening anything', () => {
    pressByText(render('[ide](editor://file/x.ts)'), 'ide')
    expect(openURL).not.toHaveBeenCalled()
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('keeps snake_case paths whole instead of shredding them as emphasis', () => {
    const rendered = render('compare src/foo_bar.ts and src/baz_qux.ts now')
    pressByText(rendered, 'src/foo_bar.ts')
    pressByText(rendered, 'src/baz_qux.ts')
    expect(onOpenFile).toHaveBeenNthCalledWith(1, 'src/foo_bar.ts')
    expect(onOpenFile).toHaveBeenNthCalledWith(2, 'src/baz_qux.ts')
  })

  it('keeps markdown links between snake_case paths tappable', () => {
    pressByText(
      render('Updated src/foo_bar.py; see [the PR](https://example.com/x) before src/baz_qux.py'),
      'the PR'
    )
    expect(openURL).toHaveBeenCalledWith('https://example.com/x')
  })

  it('opens a dunder path as one link', () => {
    pressByText(render('see a/__tests__/x.ts now'), 'a/__tests__/x.ts')
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith('a/__tests__/x.ts')
  })

  it('detects paths inside bold spans', () => {
    pressByText(render('changed **src/foo.ts** heavily'), 'src/foo.ts')
    expect(onOpenFile).toHaveBeenCalledWith('src/foo.ts')
  })

  it('excludes trailing sentence punctuation from autolinks', () => {
    pressByText(render('see https://example.com/a.'), 'https://example.com/a')
    expect(openURL).toHaveBeenCalledWith('https://example.com/a')
  })

  it('opens inline-code path:line citations', () => {
    pressByText(render('fix `src/foo.ts:42` now'), 'src/foo.ts:42')
    expect(onOpenFile).toHaveBeenCalledWith('src/foo.ts:42')
  })

  it('renders paths as plain text without onOpenFile', () => {
    act(() => {
      renderer = create(createElement(MobileMarkdown, { content: 'Edit src/app/Main.tsx now' }))
    })
    expect(pressables(renderer!)).toHaveLength(0)
  })
})
