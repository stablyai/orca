// @vitest-environment happy-dom
/**
 * What the preview mounts for each answer the shell gives, read off the element it renders.
 *
 * Its own file because of how the grant resolves here: this suite runs in a `node` environment whose
 * resolver has no `.web` precedence, so `MobileHtmlPreview.web.tsx`'s import of
 * `./use-html-preview-link-grant` lands on the native sibling, which answers yes unconditionally.
 * That is why `mobile-webview-editor-web-fallbacks.test.tsx` still measures the granted frame
 * without knowing a grant exists, and why the hidden path needs the module replaced to be reached
 * at all.
 *
 * The browser half is `config/scripts/mobile-web-app-html-preview-render.test.mjs`, which resolves
 * the real web sibling and measures what an engine paints and does. This file is the wiring between
 * the two: that the component asks, and that both the frame's sandbox and the document it is handed
 * follow the answer. It runs in the sharded `test` job, where the render rig is skipped for want of
 * the bundler's dependencies.
 *
 * happy-dom rather than the suite's `node` default, because the inerting pass the hidden arm takes
 * parses with the browser's own `DOMParser` and there is none in `node`.
 */
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
  await import('./MobileHtmlPreview.web')

const ARTIFACT =
  '<!doctype html><html><body><a id="x" href="https://example.com/a">tap</a></body></html>'

const renderers: ReactTestRenderer[] = []

/** By tag name through `String`, not a literal comparison: `node.type` is `ElementType`, which
 *  overlaps a real intrinsic tag and not the host strings these mocks render, so `=== 'Pressable'`
 *  is a comparison `tsconfig.test.json` rejects as having no overlap. */
function findHosts(renderer: ReactTestRenderer, tag: string) {
  return renderer.root.findAll((node) => String(node.type) === tag)
}

/** Mounted inside `act`, which is what `IS_REACT_ACT_ENVIRONMENT` makes mandatory: a `create`
 *  outside one commits nothing and the renderer reads as unmounted. */
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
    // An `iframe` with no `sandbox` attribute at all is a frame with every capability. Empty is the
    // maximally restrictive value, and it must not become undefined by way of a falsy check.
    expect(MOBILE_HTML_PREVIEW_SEALED_SANDBOX).toBe('')
    expect(frameOf(false)?.sandbox).toBe('')
    expect(MOBILE_HTML_PREVIEW_SANDBOX.split(' ')).toContain(
      'allow-top-navigation-by-user-activation'
    )
  })

  /**
   * Source takes the frame away on either answer, which is the whole of what this can claim.
   *
   * The `html` a Source view shows is not the component's to get wrong: `renderSource` is called
   * with no argument, so what it renders is the caller's own closure over the artifact
   * (`MobileSessionFileReader` passes `() => renderSourceText(doc.content)`). Asserting that the
   * rendered markup equals the artifact would be asserting that this file's own closure returned
   * what this file put in it, which passes whatever the component does. What the component decides
   * is whether the rewritten frame is still mounted underneath, and that is what is read here.
   */
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
