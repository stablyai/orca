import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Linking: { openURL: vi.fn() },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('Text', props, children),
    View: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles }
  }
})

import { MobileMarkdown } from './MobileMarkdown'
import { Linking } from 'react-native'

describe('MobileMarkdown file paths', () => {
  let renderer: ReactTestRenderer | null = null
  const onOpenFile = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.mocked(Linking.openURL).mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(content: string): ReactTestRenderer {
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    try {
      act(() => {
        renderer = create(createElement(MobileMarkdown, { content, onOpenFile }))
      })
    } finally {
      spy.mockRestore()
    }
    return renderer!
  }

  it('opens an absolute POSIX prose path', () => {
    const path =
      '/Users/jinjingliang/Documents/projects/orca/worktree/docs/native-chat-rendering-architecture.md'
    const link = render(`Open ${path}`).root.find(
      (node) => node.type === 'Text' && node.props.accessibilityLabel === `Open file ${path}`
    )

    act(() => link.props.onPress())

    expect(onOpenFile).toHaveBeenCalledWith({
      pathText: path,
      line: null,
      column: null
    })
  })

  it('routes a markdown file link with its source position', () => {
    const link = render('[source](docs/STYLEGUIDE.md:12:3)').root.find(
      (node) =>
        node.type === 'Text' && node.props.accessibilityLabel === 'Open file docs/STYLEGUIDE.md'
    )

    act(() => link.props.onPress())

    expect(onOpenFile).toHaveBeenCalledWith({
      pathText: 'docs/STYLEGUIDE.md',
      line: 12,
      column: 3
    })
  })

  it('normalizes encoded, fragmented, and file URI markdown targets', () => {
    const encoded = render('[source](docs/My%20File.ts#L12)').root.find(
      (node) =>
        node.type === 'Text' && node.props.accessibilityLabel === 'Open file docs/My File.ts'
    )
    act(() => encoded.props.onPress())
    expect(onOpenFile).toHaveBeenLastCalledWith({
      pathText: 'docs/My File.ts',
      line: 12,
      column: null
    })

    const fileUri = render('[source](file:///repo/src/app.ts#L9)').root.find(
      (node) =>
        node.type === 'Text' && node.props.accessibilityLabel === 'Open file /repo/src/app.ts'
    )
    act(() => fileUri.props.onPress())
    expect(onOpenFile).toHaveBeenLastCalledWith({
      pathText: '/repo/src/app.ts',
      line: 9,
      column: null
    })

    const angle = render('[source](<docs/My%20File.ts>)').root.find(
      (node) =>
        node.type === 'Text' && node.props.accessibilityLabel === 'Open file docs/My File.ts'
    )
    act(() => angle.props.onPress())
    expect(onOpenFile).toHaveBeenLastCalledWith({
      pathText: 'docs/My File.ts',
      line: null,
      column: null
    })

    const titled = render('[source](src/app.ts "source")').root.find(
      (node) => node.type === 'Text' && node.props.accessibilityLabel === 'Open file src/app.ts'
    )
    act(() => titled.props.onPress())
    expect(onOpenFile).toHaveBeenLastCalledWith({
      pathText: 'src/app.ts',
      line: null,
      column: null
    })

    const positioned = render('[source](src/app.ts#L12C3)').root.find(
      (node) => node.type === 'Text' && node.props.accessibilityLabel === 'Open file src/app.ts'
    )
    act(() => positioned.props.onPress())
    expect(onOpenFile).toHaveBeenLastCalledWith({
      pathText: 'src/app.ts',
      line: 12,
      column: 3
    })
  })

  it('keeps web links out of host file routing', () => {
    const link = render('[site](https://example.com/docs/app.ts)').root.find(
      (node) => node.type === 'Text' && node.children.join('') === 'site'
    )
    act(() => link.props.onPress())
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(Linking.openURL).toHaveBeenCalledWith('https://example.com/docs/app.ts')
  })

  it('opens extensionless and balanced-route markdown targets', () => {
    const dockerfile = render('[container](Dockerfile)').root.find(
      (node) => node.type === 'Text' && node.props.accessibilityLabel === 'Open file Dockerfile'
    )
    act(() => dockerfile.props.onPress())
    expect(onOpenFile).toHaveBeenLastCalledWith({
      pathText: 'Dockerfile',
      line: null,
      column: null
    })

    const route = 'app/(shop)/products/[id]/page.tsx'
    const routeLink = render(`[source](${route})`).root.find(
      (node) => node.type === 'Text' && node.props.accessibilityLabel === `Open file ${route}`
    )
    act(() => routeLink.props.onPress())
    expect(onOpenFile).toHaveBeenLastCalledWith({
      pathText: route,
      line: null,
      column: null
    })
  })

  it('preserves Windows drive and UNC markdown targets', () => {
    for (const path of [String.raw`C:\repo\(shop)\page.tsx`, String.raw`\\server\share\app.ts`]) {
      const link = render(`[source](${path})`).root.find(
        (node) => node.type === 'Text' && node.props.accessibilityLabel === `Open file ${path}`
      )
      act(() => link.props.onPress())
      expect(onOpenFile).toHaveBeenLastCalledWith({
        pathText: path,
        line: null,
        column: null
      })
    }
  })

  it('does not split underscored prose paths into emphasis tokens', () => {
    for (const path of ['src/foo_bar_baz.ts', 'src/__init__.py']) {
      const link = render(path).root.find(
        (node) => node.type === 'Text' && node.props.accessibilityLabel === `Open file ${path}`
      )
      act(() => link.props.onPress())
      expect(onOpenFile).toHaveBeenLastCalledWith({
        pathText: path,
        line: null,
        column: null
      })
    }
  })
})
