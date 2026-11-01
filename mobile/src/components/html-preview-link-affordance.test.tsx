// @vitest-environment happy-dom
// Assert component follows shell grant for both sandbox and inerted document; native test resolver needs explicit web-grant substitution.
// happy-dom supplies DOMParser for hidden arm. Real browser rig uses actual web sibling; this wiring suite still runs when bundler-dependent rig skips.
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const shell = { opensLinks: true }

vi.mock('./use-html-preview-link-grant', () => ({
  useHtmlPreviewLinkGrant: () => shell.opensLinks
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    View: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('View', props, children),
    Text: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('Text', props, children),
    Pressable: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('Pressable', props, children),
    StyleSheet: { create: (styles: unknown) => styles }
  }
})

vi.mock('lucide-react-native', () => ({
  Code: () => null,
  Eye: () => null
}))

const { MobileHtmlPreview, MOBILE_HTML_PREVIEW_SANDBOX, MOBILE_HTML_PREVIEW_SEALED_SANDBOX } =
  await import('./MobileHtmlPreview')

const ARTIFACT =
  '<!doctype html><html><body><a id="x" href="https://example.com/a">tap</a></body></html>'

const renderers: ReactTestRenderer[] = []

// Match mock host tag through String: renderer ElementType rejects literal Pressable comparison without cast.
function findHosts(renderer: ReactTestRenderer, tag: string) {
  return renderer.root.findAll((node) => String(node.type) === tag)
}

// Mount inside act as required by IS_REACT_ACT_ENVIRONMENT; otherwise create commits nothing.
function mount(renderSource: () => React.ReactNode): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(MobileHtmlPreview, { html: ARTIFACT, renderSource }))
  })
  if (renderer === null) {
    throw new Error('nothing mounted')
  }
  renderers.push(renderer)
  return renderer
}

function frameOf(opensLinks: boolean) {
  shell.opensLinks = opensLinks
  const frames = findHosts(
    mount(() => createElement('SourceView', null)),
    'iframe'
  )
  expect(frames).toHaveLength(1)
  return frames[0]?.props
}

afterEach(() => {
  shell.opensLinks = true
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount())
  }
})

describe('the frame the preview mounts for each answer the shell gives', () => {
  it('hands the artifact over untouched when the shell can open a link', () => {
    const frame = frameOf(true)
    expect(frame?.srcDoc).toBe(ARTIFACT)
    expect(frame?.sandbox).toBe(MOBILE_HTML_PREVIEW_SANDBOX)
  })

  it('hands over an artifact with no link, in a frame that cannot navigate, when it cannot', () => {
    const frame = frameOf(false)
    // Both fences follow the one answer, which is the wiring this file exists for.
    expect(frame?.sandbox).toBe(MOBILE_HTML_PREVIEW_SEALED_SANDBOX)
    expect(frame?.srcDoc).not.toContain('href')
    // The author's text is still there, so this is a hidden affordance and not a deletion.
    expect(frame?.srcDoc).toContain('tap')
    expect(frame?.srcDoc).toContain('id="x"')
  })

  it('seals the frame with a sandbox that grants nothing, rather than dropping the attribute', () => {
    // Require empty sandbox attribute: absent/undefined grants every capability, while empty grants none.
    expect(MOBILE_HTML_PREVIEW_SEALED_SANDBOX).toBe('')
    expect(frameOf(false)?.sandbox).toBe('')
    expect(MOBILE_HTML_PREVIEW_SANDBOX.split(' ')).toContain(
      'allow-top-navigation-by-user-activation'
    )
  })

  // Source toggle must unmount preview on either grant answer; caller’s renderSource closure owns original markup, so testing its own fixture echo would prove nothing.
  it('takes the frame away when Source is showing, on either answer', () => {
    for (const opensLinks of [true, false]) {
      shell.opensLinks = opensLinks
      const renderer = mount(() => createElement('SourceView', null))
      // The precondition: a frame was mounted, so its absence below is the toggle's doing.
      expect(findHosts(renderer, 'iframe'), String(opensLinks)).toHaveLength(1)
      const toSource = findHosts(renderer, 'Pressable').find(
        (node) => node.props.accessibilityLabel === 'View HTML source'
      )
      expect(toSource, String(opensLinks)).toBeDefined()
      act(() => toSource?.props.onPress())
      expect(findHosts(renderer, 'SourceView'), String(opensLinks)).toHaveLength(1)
      // Nothing is parsing the artifact while Source is showing, rewritten or not.
      expect(findHosts(renderer, 'iframe'), String(opensLinks)).toHaveLength(0)
    }
  })
})
