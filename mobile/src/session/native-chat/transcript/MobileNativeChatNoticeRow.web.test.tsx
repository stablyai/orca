// @vitest-environment happy-dom
import { MOBILE_WEB_APP_NATIVE_PARITY_STYLE } from '../../../../../config/scripts/build-mobile-web-app-bundle.mjs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import type * as ReactNative from 'react-native'
import type * as ReactNativeSvg from 'react-native-svg'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))
// Use the same SVG web host selected by the page bundler, overriding the native setup stand-in.
vi.mock('react-native-svg', async () => {
  const { createRequire } = await import('node:module')
  const { resolve } = await import('node:path')
  // Anchor the mobile-only dependency here, even when the mocker runs from root dependencies.
  const fromMobile = createRequire(resolve('package.json'))
  return vi.importActual<typeof ReactNativeSvg>(
    fromMobile.resolve('react-native-svg/lib/module/elements.web.js')
  )
})
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: () => null }))
vi.mock('../../../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: () => null
}))

const cases = [
  [
    'codex',
    'notification:guardianWarning',
    'Codex reported a safety review warning. View details.'
  ],
  ['claude', 'message:system:permission_denied', 'Claude denied permission. View details.']
] as const
let root: Root
let container: HTMLDivElement
let policy: HTMLDivElement
const openActions = vi.fn()
const overlays = { openActions, openImage: () => {} }
const text = `${'安全 '.repeat(1500)}EXPLANATION_SENTINEL`
const head = `{"partial":"${'é'.repeat(4500)}PAYLOAD_SENTINEL`

beforeEach(() => {
  policy = document.createElement('div')
  policy.innerHTML = MOBILE_WEB_APP_NATIVE_PARITY_STYLE
  document.head.append(policy)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  openActions.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  policy.remove()
  window.getSelection()?.removeAllRanges()
})
function render(provider: string, kind: string) {
  const notice: NativeChatMessage = {
    id: 'notice',
    role: 'system',
    source: 'transcript',
    timestamp: null,
    blocks: [
      {
        type: 'text',
        tone: provider === 'claude' ? 'error' : 'warning',
        text,
        providerFrame: {
          provider,
          kind,
          payload: { head, byteLength: 99999, digest: 'synthetic', truncated: true }
        }
      }
    ]
  }
  act(() =>
    root.render(
      <MobileNativeChatRowOverlaysContext.Provider value={overlays}>
        <MobileNativeChatMessage message={notice} />
        <MobileNativeChatMessage
          message={{
            ...notice,
            id: 'control',
            blocks: [{ type: 'text', tone: 'warning', text: 'Ordinary warning control' }]
          }}
        />
      </MobileNativeChatRowOverlaysContext.Provider>
    )
  )
  const button = container.querySelector('[role="button"]')
  if (!(button instanceof HTMLElement)) {
    throw new Error('Missing notice disclosure')
  }
  return button
}
function touch(node: Element, type: 'touchstart' | 'touchend') {
  const finger = { identifier: 1, target: node, pageX: 10, pageY: 10, clientX: 10, clientY: 10 }
  node.dispatchEvent(
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      touches: type === 'touchstart' ? [finger] : [],
      changedTouches: [finger]
    })
  )
}
function select(node: Element) {
  const range = document.createRange()
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  const first = walker.nextNode()!
  let last = first
  while (walker.nextNode()) {
    last = walker.currentNode
  }
  range.setStart(first, 0)
  range.setEnd(last, last.textContent!.length)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}
function tap(node: HTMLElement) {
  act(() => {
    touch(node, 'touchstart')
    touch(node, 'touchend')
    node.click()
  })
}

it.each(cases)(
  'keeps %s summary selection separate from activation in the web page',
  (provider, kind, heading) => {
    const button = render(provider, kind)
    const summary = Array.from(button.querySelectorAll('div')).find(
      (node) => node.textContent === heading
    )!
    const control = Array.from(container.querySelectorAll('div')).find(
      (node) => node.childElementCount === 0 && node.textContent === 'Ordinary warning control'
    )!
    expect(getComputedStyle(document.body).userSelect).toBe('none')
    expect(getComputedStyle(control).userSelect).toBe('text')
    expect(getComputedStyle(summary).userSelect).toBe('text')
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(1)
    expect(button.getAttribute('aria-label')).toBe(heading)
    expect(button.tabIndex).toBe(0)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent!.includes('EXPLANATION_SENTINEL')).toBe(false)
    act(() => {
      touch(summary, 'touchstart')
      select(summary)
      touch(summary, 'touchend')
      summary.click()
    })
    expect(window.getSelection()!.toString()).toBe(heading)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent!.includes('EXPLANATION_SENTINEL')).toBe(false)
    expect(openActions).not.toHaveBeenCalled()
    window.getSelection()!.removeAllRanges()
    tap(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent!.includes('EXPLANATION_SENTINEL')).toBe(true)
    const detail = Array.from(container.querySelectorAll('div')).find(
      (node) => node.childElementCount === 0 && node.textContent?.startsWith(text)
    )!
    expect(detail.textContent).toContain(text)
    expect(detail.textContent).toContain(head)
    expect(detail.textContent).toContain(
      'Provider response truncated (original size: 99999 bytes).'
    )
    expect(getComputedStyle(detail).userSelect).toBe('text')
    act(() => select(detail))
    expect(window.getSelection()!.toString()).toContain('PAYLOAD_SENTINEL')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent!.includes('EXPLANATION_SENTINEL')).toBe(true)
    window.getSelection()!.removeAllRanges()
    tap(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent!.includes('EXPLANATION_SENTINEL')).toBe(false)
    act(() => {
      expect(button.tagName).toBe('BUTTON')
      // happy-dom does not synthesize a native button's keyboard-origin click.
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent!.includes('EXPLANATION_SENTINEL')).toBe(true)
    tap(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent!.includes('EXPLANATION_SENTINEL')).toBe(false)
  }
)

it.each(cases)(
  'rotates the %s caret wrapper without transforming SVG or paths',
  (provider, kind) => {
    const button = render(provider, kind)
    const svg = button.querySelector('svg')!
    const wrapper = svg.parentElement!
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    expect(svg.querySelector('path')?.getAttribute('d')).toBeTruthy()
    expect(getComputedStyle(wrapper).transform).toMatch(/^(none)?$/)
    tap(button)
    expect(getComputedStyle(wrapper).transform).toBe('rotate(90deg)')
    for (const node of [svg, ...svg.querySelectorAll('path')]) {
      expect(getComputedStyle(node).transform).toMatch(/^(none)?$/)
      expect(node.hasAttribute('transform')).toBe(false)
    }
    tap(button)
    expect(getComputedStyle(wrapper).transform).toMatch(/^(none)?$/)
  }
)
