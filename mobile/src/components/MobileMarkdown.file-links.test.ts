import { createElement } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'

const openURL = vi.fn(() => Promise.resolve())

vi.mock('react-native', () => ({
  Image: 'Image',
  Linking: { openURL: (url: string) => openURL(url) },
  Platform: { OS: 'ios' },
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
    onOpenFile.mockClear()
    openURL.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(
    content: string,
    imageSources?: Record<string, string>,
    onOpenImage?: (rawSrc: string) => void
  ): ReactTestRenderer {
    act(() => {
      renderer = create(
        createElement(MobileMarkdown, { content, onOpenFile, imageSources, onOpenImage })
      )
    })
    return renderer!
  }

  it('preserves a long unmatched bracket run as literal rendered text', () => {
    const text = '['.repeat(60_000)
    const tree = render(text)
    expect(flattenText(tree.root)).toBe(text)
    expect(pressables(tree)).toEqual([])
  })

  it('preserves nested labels and empty image labels', () => {
    const tree = render('[[nested](https://example.com) ![](https://example.com/image)')
    pressByText(tree, '[nested')
    expect(openURL).toHaveBeenLastCalledWith('https://example.com')
    pressByText(tree, 'image')
    expect(openURL).toHaveBeenLastCalledWith('https://example.com/image')
  })

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

  describe('resolved relative images', () => {
    const sources = { 'docs/shot.png': 'data:image/png;base64,AAA' }

    function images(rendered: ReactTestRenderer): ReactTestInstance[] {
      return rendered.root.findAll((node) => String(node.type) === 'Image')
    }

    function pressImage(image: ReactTestInstance): void {
      let target: ReactTestInstance | null = image
      while (target && typeof target.props.onPress !== 'function') {
        target = target.parent
      }
      expect(target, 'no tappable ancestor of the image').not.toBeNull()
      act(() => {
        target!.props.onPress()
      })
    }

    it('renders an inline image from its resolved data URL, tappable to the file', () => {
      const tree = render('see ![shot](docs/shot.png) here', sources)
      const image = images(tree)
      expect(image).toHaveLength(1)
      expect(image[0]!.props.source).toEqual({ uri: 'data:image/png;base64,AAA' })
      pressImage(image[0]!)
      expect(onOpenFile).toHaveBeenCalledWith('docs/shot.png')
    })

    it('renders an unresolved inline image as the tappable fallback text', () => {
      const tree = render('see ![shot](docs/shot.png) here')
      expect(images(tree)).toHaveLength(0)
      pressByText(tree, 'shot')
      expect(onOpenFile).toHaveBeenCalledWith('docs/shot.png')
    })

    it('renders a standalone image full width from its resolved data URL', () => {
      const tree = render('![shot](docs/shot.png)', sources)
      const image = images(tree)
      expect(image).toHaveLength(1)
      expect(image[0]!.props.style).toMatchObject({ width: '100%' })
      pressImage(image[0]!)
      expect(onOpenFile).toHaveBeenCalledWith('docs/shot.png')
    })

    it('keeps an unresolved standalone image as prose', () => {
      const tree = render('![shot](docs/shot.png)')
      expect(images(tree)).toHaveLength(0)
      pressByText(tree, 'shot')
      expect(onOpenFile).toHaveBeenCalledWith('docs/shot.png')
    })

    it('routes a tapped image to the dedicated image handler instead of the file opener', () => {
      const onOpenImage = vi.fn()
      const tree = render('![shot](docs/shot.png)', sources, onOpenImage)
      pressImage(images(tree)[0]!)
      expect(onOpenImage).toHaveBeenCalledWith('docs/shot.png')
      expect(onOpenFile).not.toHaveBeenCalled()
    })

    it('routes an unresolved inline image fallback to the dedicated image handler', () => {
      const onOpenImage = vi.fn()
      const tree = render('see ![shot](docs/shot.png) here', undefined, onOpenImage)
      pressByText(tree, 'shot')
      expect(onOpenImage).toHaveBeenCalledWith('docs/shot.png')
      expect(onOpenFile).not.toHaveBeenCalled()
    })

    it('keeps an external image on the system browser even with the image handler', () => {
      const onOpenImage = vi.fn()
      const tree = render('![chart](https://example.com/chart.png)', undefined, onOpenImage)
      // An external standalone image parses as an image block: the handler sits on the Pressable.
      const frame = tree.root.find(
        (node) => node.type === ('Pressable' as never) && typeof node.props.onPress === 'function'
      )
      act(() => {
        frame.props.onPress()
      })
      expect(openURL).toHaveBeenCalledWith('https://example.com/chart.png')
      expect(onOpenImage).not.toHaveBeenCalled()
      expect(onOpenFile).not.toHaveBeenCalled()
    })
  })
})
