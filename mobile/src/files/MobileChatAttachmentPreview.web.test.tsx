// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { RpcResponse } from '../transport/types'
import type * as ReactNative from 'react-native'
import { expect, it, vi } from 'vitest'
import { MobileChatAttachmentPreview } from './MobileChatAttachmentPreview'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import { useMobileFileTapHandlers } from '../session/use-mobile-file-tap-handlers'
import { MobileNativeChatComposerAttachments } from '../session/native-chat/composer/MobileNativeChatComposerAttachments'
import { normalizeMobileFilePreviewRouteParams } from './mobile-file-preview-route'

import { AttachmentTextSource } from '../../../src/shared/attachment-text-source'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => createElement('div', null, children)
}))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'light' }))
const mocks = vi.hoisted(() => ({ send: vi.fn(), back: vi.fn(), write: vi.fn(), push: vi.fn() }))
vi.mock('../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({ back: mocks.back, push: mocks.push })
}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: mocks.write }) }))
const client = {
  sendRequest: (...args: unknown[]) => mocks.send(...args),
  getState: () => 'connected' as const,
  getLastConnectedAt: () => 1,
  getGeneration: () => 1
}
vi.mock('../transport/use-workspace-client', () => ({
  useWorkspaceClient: () => ({ client, state: 'connected' })
}))

it('opens the phone attachment card, scrolls the actual RN-web list to its tail and copies eligible complete text', async () => {
  await activateMobileUiLocale('en')
  let viewportHeight = 600
  const children = (node: HTMLElement) =>
    Array.from(node.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
  const flowChildren = (node: HTMLElement) =>
    children(node).filter((child) => getComputedStyle(child).position !== 'absolute')
  const height = (node: HTMLElement): number => {
    const style = getComputedStyle(node)
    if (node.style.height.endsWith('px')) {
      return Number.parseFloat(node.style.height)
    }
    if ([style.overflowX, style.overflowY].some((value) => ['auto', 'scroll'].includes(value))) {
      return viewportHeight
    }
    const fixed = Number.parseFloat(style.height)
    if (Number.isFinite(fixed)) {
      return fixed
    }
    const children = flowChildren(node).map(height)
    return Math.max(
      Number.parseFloat(style.minHeight) || 0,
      children.length
        ? style.flexDirection === 'row'
          ? Math.max(...children)
          : children.reduce((sum, value) => sum + value, 0)
        : node.children.length === 0 && node.textContent
          ? 19
          : 0
    )
  }
  const width = (node: HTMLElement): number => {
    if (node.style.opacity === '0') {
      return 8
    }
    const value = getComputedStyle(node).width
    const fixed = Number.parseFloat(value)
    const available = node.parentElement ? width(node.parentElement) : 390
    return Number.isFinite(fixed)
      ? value.endsWith('%')
        ? (available * fixed) / 100
        : fixed
      : available
  }
  const descriptors = new Map<string, PropertyDescriptor | undefined>()
  const descendantBottom = (node: HTMLElement): number => {
    const style = getComputedStyle(node)
    return [style.overflow, style.overflowY].some((value) =>
      ['hidden', 'clip', 'auto', 'scroll'].includes(value)
    )
      ? height(node)
      : Math.max(
          height(node),
          ...children(node).map((child) => child.offsetTop + descendantBottom(child))
        )
  }
  const metrics = {
    offsetHeight: height,
    clientHeight: height,
    offsetWidth: width,
    clientWidth: width,
    scrollHeight: (node: HTMLElement) =>
      Math.max(
        height(node),
        ...children(node).map((child) => child.offsetTop + descendantBottom(child))
      ),
    scrollWidth: (node: HTMLElement) =>
      Math.max(width(node), ...flowChildren(node).map((child) => child.scrollWidth)),
    offsetParent: (node: HTMLElement) => node.parentElement,
    offsetLeft: (node: HTMLElement) => Number.parseFloat(getComputedStyle(node).left) || 0,
    offsetTop: (node: HTMLElement) => {
      const style = getComputedStyle(node)
      if (style.position === 'absolute') {
        return Number.parseFloat(style.top) || 0
      }
      const parent = node.parentElement
      if (!parent || getComputedStyle(parent).flexDirection === 'row') {
        return 0
      }
      const siblings = flowChildren(parent)
      return siblings
        .slice(0, siblings.indexOf(node))
        .reduce((sum, sibling) => sum + height(sibling), 0)
    }
  }
  for (const [name, measure] of Object.entries(metrics)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return measure(this)
      }
    })
  }
  const positions = new WeakMap<HTMLElement, number>()
  const nativePositions = new WeakMap<HTMLElement, number>()
  const horizontal = new WeakMap<HTMLElement, number>()
  let deliverScroll = true
  descriptors.set(
    'scrollLeft',
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollLeft')
  )
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get(this: HTMLElement) {
      const left = Math.min(
        horizontal.get(this) || 0,
        Math.max(0, this.scrollWidth - this.clientWidth)
      )
      horizontal.set(this, left)
      return left
    },
    set(this: HTMLElement, value: number) {
      horizontal.set(this, Math.max(0, Math.min(value, this.scrollWidth - this.clientWidth)))
    }
  })
  descriptors.set('scrollTop', Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop'))
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return (
        nativePositions.get(this) ??
        Math.min(positions.get(this) || 0, Math.max(0, this.scrollHeight - this.clientHeight))
      )
    },
    set(this: HTMLElement, value: number) {
      nativePositions.delete(this)
      const top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
      if (top !== this.scrollTop) {
        positions.set(this, top)
        if (deliverScroll) {
          queueMicrotask(() => this.dispatchEvent(new Event('scroll')))
        }
      }
    }
  })
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      let x = this.offsetLeft,
        y = this.offsetTop
      for (let parent = this.parentElement; parent; parent = parent.parentElement) {
        x += parent.offsetLeft - parent.scrollLeft
        y += parent.offsetTop - parent.scrollTop
      }
      return new DOMRect(x, y, width(this), height(this))
    })
  const NativeResizeObserver = globalThis.ResizeObserver
  vi.stubGlobal(
    'ResizeObserver',
    class extends NativeResizeObserver {
      constructor(private readonly notify: ResizeObserverCallback) {
        super(notify)
      }
      observe(target: Element) {
        super.observe(target)
        const box = {
          inlineSize: target.getBoundingClientRect().width,
          blockSize: target.getBoundingClientRect().height
        }
        this.notify(
          [
            {
              target,
              contentRect: target.getBoundingClientRect(),
              borderBoxSize: [box],
              contentBoxSize: [box],
              devicePixelContentBoxSize: [box]
            }
          ],
          this
        )
      }
    }
  )
  const path = '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/report.txt'
  let content = Buffer.from(`${'\n'.repeat(25 * 1024 * 1024)}TAIL`)
  const sourceBlocks = vi.spyOn(AttachmentTextSource.prototype, 'block')
  const reads: { offset: number; length: number }[] = []
  let hold: Promise<void> | undefined
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  mocks.send.mockImplementation(
    async (method: string, request?: { offset: number; length: number }): Promise<RpcResponse> => {
      if (method === 'status.get') {
        return {
          id: 's',
          ok: true,
          result: { capabilities: ['native-chat.text-attachment-read.v1'] }
        }
      }
      if (!request) {
        throw new Error('Expected actual range')
      }
      reads.push(request)
      if (hold && request.offset > 0) {
        held.resolve()
        await hold
      }
      const part = content.subarray(request.offset, request.offset + request.length)
      return {
        id: 'r',
        ok: true,
        result: {
          snapshot: 'a'.repeat(64),
          size: content.length,
          bytesRead: part.length,
          contentBase64: part.toString('base64'),
          eof: request.offset + part.length === content.length
        }
      }
    }
  )
  function Card() {
    const handlers = useMobileFileTapHandlers({
      client,
      hostId: 'owner',
      worktreeId: 'folder:work',
      worktreeName: 'Work',
      nativeChatSessionId: 's',
      structuredAttachments: true,
      activeHandleRef: { current: null },
      terminalCwdRef: { current: new Map() },
      openBrowser: vi.fn(),
      fetchSessionTabs: async () => {},
      getSessionTabs: () => [],
      getActiveSessionTabId: () => 'chat',
      getActiveSessionTabType: () => 'agent-session',
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn(),
      reportChatTapFailure: vi.fn()
    })
    return createElement(MobileNativeChatComposerAttachments, {
      images: [],
      files: [
        { id: 'file', name: 'report.txt', mime: 'text/plain', byteLength: content.length, path }
      ],
      onOpenFile: handlers.handleNativeChatFileTap
    })
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const button = (name: string) => {
    const element = Array.from(container.querySelectorAll('[role="button"]')).find(
      (node) => node.textContent === name
    )
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Missing ${name}`)
    }
    return element
  }
  const flush = () => act(async () => {})
  try {
    await act(async () => root.render(createElement(Card)))
    const card = container.querySelector('[role="button"]')
    if (!(card instanceof HTMLElement)) {
      throw new Error('Missing real attachment card')
    }
    act(() => card.click())
    const route = normalizeMobileFilePreviewRouteParams(mocks.push.mock.calls[0][0].params)
    if (!route.ok) {
      throw new Error('Expected structured attachment route')
    }
    expect(route.params.absolutePath).toBe(path)
    await act(async () =>
      root.render(createElement(MobileChatAttachmentPreview, { params: route.params }))
    )
    // Supply browser layout, not source results or callbacks; the real list owns scrolling and demand.
    const scroller = Array.from(container.querySelectorAll('div')).find((node) =>
      ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)
    )
    if (!(scroller instanceof HTMLElement)) {
      throw new Error('Expected actual RN-web scroll host')
    }
    await vi.waitFor(async () => {
      await flush()
      expect(scroller.offsetHeight).toBe(viewportHeight)
      expect(scroller.offsetWidth).toBeGreaterThan(0)
      expect(reads.length).toBeGreaterThan(0)
      // Visible rows prove the async RN-web onLayout and initial source publication have settled.
      expect(
        container.querySelectorAll('[data-testid="attachment-text-segment"]').length
      ).toBeGreaterThan(Math.floor(viewportHeight / 19))
    })
    expect(button('Copy').getAttribute('aria-disabled')).toBe('true')
    expect(button('Save').getAttribute('aria-disabled')).toBe('true')
    const source = sourceBlocks.mock.contexts.at(-1)
    if (!(source instanceof AttachmentTextSource)) {
      throw new Error('Expected actual source identity')
    }
    const { AttachmentTextViewport } = await import('../../../src/shared/attachment-text-viewport')
    const track = new AttachmentTextViewport(source, 19, scroller.clientHeight)
    await act(async () => {
      scroller.scrollTop = track.total - scroller.clientHeight
      scroller.dispatchEvent(new Event('scroll'))
    })
    await vi.waitFor(async () => {
      await flush()
      expect(container.textContent).toContain('TAIL')
      expect(scroller.scrollTop + scroller.clientHeight).toBe(scroller.scrollHeight)
    })
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(reads.every((request) => request.length <= 16 * 1024)).toBe(true)
    expect(
      container.querySelectorAll('[data-testid="attachment-text-segment"]').length
    ).toBeGreaterThan(0)
    expect(
      container.querySelectorAll('[data-testid="attachment-text-segment"]').length
    ).toBeLessThanOrEqual(Math.ceil(viewportHeight / 19) + 4)
    // Discover enough real ranges through scrolling to exercise a compressed physical track.
    for (let block = 1; block < 32; block++) {
      const current = new AttachmentTextViewport(source, 19, scroller.clientHeight)
      if (current.scale < 1) {
        break
      }
      await act(async () => {
        scroller.scrollTop = current.position({ block, row: 1 })
        scroller.dispatchEvent(new Event('scroll'))
      })
      await vi.waitFor(async () => {
        await flush()
        expect(source.rowKnown(block)).toBe(true)
      })
    }
    const compressed = new AttachmentTextViewport(source, 19, scroller.clientHeight)
    expect(compressed.scale).toBeLessThan(1)
    await act(async () => {
      scroller.scrollTop = compressed.total - compressed.height - 1
      scroller.dispatchEvent(new Event('scroll'))
    })
    await vi.waitFor(async () => {
      await flush()
      const rows = Array.from(
        container.querySelectorAll<HTMLElement>('[data-testid="attachment-text-segment"]')
      )
      const declared = Number.parseFloat(rows[0]!.parentElement!.style.height)
      expect(container.textContent).toContain('TAIL')
      expect(Math.max(...rows.map((row) => row.offsetTop + row.offsetHeight))).toBeGreaterThan(
        declared
      )
      expect(scroller.scrollHeight).toBe(Math.max(scroller.clientHeight, declared))
    })
    await act(async () => {
      scroller.scrollTop = 0
      scroller.dispatchEvent(new Event('scroll'))
    })
    await act(async () => button('Back').click())
    expect(mocks.back).toHaveBeenCalledOnce()
    content = Buffer.from('x'.repeat(96 * 1024))
    await act(async () =>
      root.render(
        createElement(MobileChatAttachmentPreview, { key: 'motion', params: route.params })
      )
    )
    await vi.waitFor(async () => {
      await flush()
      expect(container.querySelector('[data-testid="attachment-text-segment"]')?.textContent).toBe(
        'x'.repeat(256)
      )
    })
    const motion = Array.from(container.querySelectorAll('div')).find((node) =>
      ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)
    )
    if (!(motion instanceof HTMLElement)) {
      throw new Error('Missing actual vertical host')
    }
    let outer = motion.parentElement
    while (outer && !['auto', 'scroll'].includes(getComputedStyle(outer).overflowX)) {
      outer = outer.parentElement
    }
    if (!outer) {
      throw new Error('Missing actual horizontal host')
    }
    const hostScroll = vi.spyOn(motion, 'scrollTo')
    try {
      outer.scrollLeft = 500
      hold = release.promise
      await act(async () => {
        motion.scrollTop = 3000
      })
      await held.promise
      expect(outer.scrollLeft).toBe(500)
      deliverScroll = false
      motion.scrollTop += 80
      const live = motion.scrollTop
      const calls = hostScroll.mock.calls.length
      hold = undefined
      await act(async () => release.resolve())
      await vi.waitFor(async () => {
        await flush()
        expect(
          container.querySelector('[data-testid="attachment-text-segment"]')?.textContent
        ).toBe('x'.repeat(256))
      })
      expect(hostScroll.mock.calls.length).toBe(calls)
      expect(motion.scrollTop).toBe(live)
      expect(outer.scrollLeft).toBe(500)
      deliverScroll = true
      await act(async () => {
        motion.scrollTop = 0
        motion.dispatchEvent(new Event('scroll'))
      })
      await vi.waitFor(async () => {
        await flush()
        expect(motion.scrollTop).toBe(0)
        expect(
          container.querySelector('[data-testid="attachment-text-segment"]')?.textContent
        ).toBe('x'.repeat(256))
      })
      expect(outer.scrollLeft).toBe(500)
    } finally {
      release.resolve()
      deliverScroll = true
      hostScroll.mockRestore()
    }
    viewportHeight = 645
    const line = 'Original pasted contents 35636; exact Copy and Save.\n'
    const header = `COPY35636-START\n    indented\tfield    value; whitespace35636\n        ${line}`
    const tail = '\nCOPY35636-END\n'
    content = Buffer.from((header + line.repeat(2000)).slice(0, 98304 - tail.length) + tail)
    await act(async () =>
      root.render(
        createElement(MobileChatAttachmentPreview, { key: 'elastic', params: route.params })
      )
    )
    await vi.waitFor(async () => {
      await flush()
      expect(container.textContent).toContain('COPY35636-START')
    })
    const elasticSource = sourceBlocks.mock.contexts.at(-1)
    const elastic = Array.from(container.querySelectorAll('div')).find((node) =>
      ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)
    )
    if (!(elasticSource instanceof AttachmentTextSource) || !(elastic instanceof HTMLElement)) {
      throw new Error('Missing actual literal source/host')
    }
    await vi.waitFor(async () => {
      await flush()
      expect(elastic.clientHeight).toBe(645)
    })
    for (let block = 1; block < elasticSource.blockCount; block++) {
      const current = new AttachmentTextViewport(elasticSource, 19, elastic.clientHeight)
      await act(async () => {
        elastic.scrollTop = current.position({ block, row: 1 })
        elastic.dispatchEvent(new Event('scroll'))
      })
      await vi.waitFor(async () => {
        await flush()
        expect(elasticSource.rowKnown(block)).toBe(true)
      })
    }
    const elasticTrack = new AttachmentTextViewport(elasticSource, 19, elastic.clientHeight)
    expect(elasticTrack.total).toBe(35283)
    const nativeScroll = async (top: number) =>
      act(async () => {
        nativePositions.set(elastic, top)
        elastic.dispatchEvent(new Event('scroll'))
      })
    const elasticWrites = vi.spyOn(elastic, 'scrollTo')
    try {
      const writes = elasticWrites.mock.calls.length
      for (const top of [35545, 34931]) {
        await nativeScroll(top)
        await vi.waitFor(async () => {
          await flush()
          const rows = Array.from(
            container.querySelectorAll<HTMLElement>('[data-testid="attachment-text-segment"]')
          )
          expect(rows[0]?.offsetTop).toBe(34637)
          expect(rows.at(-1)!.offsetTop + rows.at(-1)!.offsetHeight).toBe(35283)
          expect(elastic.scrollHeight).toBe(35283)
        })
      }
      await nativeScroll(34638 - 645)
      await vi.waitFor(async () => {
        await flush()
        expect(
          container.querySelector<HTMLElement>('[data-testid="attachment-text-segment"]')!.offsetTop
        ).toBeLessThan(34637)
      })
      expect(elasticWrites.mock.calls.length).toBe(writes)
    } finally {
      elasticWrites.mockRestore()
    }
    viewportHeight = 600
    content = Buffer.from('🙂'.repeat((25 * 1024 * 1024) / 4))
    await act(async () =>
      root.render(
        createElement(MobileChatAttachmentPreview, { key: 'unicode', params: route.params })
      )
    )
    await vi.waitFor(async () => {
      await flush()
      const rows = container.querySelectorAll('[data-testid="attachment-text-segment"]')
      expect(rows.length).toBeGreaterThanOrEqual(Math.ceil(viewportHeight / 19))
      expect(rows.length).toBeLessThanOrEqual(Math.ceil(viewportHeight / 19) + 4)
      expect(rows[0]?.textContent).toBe('🙂'.repeat(256))
    })
    const literal = '    indented\tfield    value'
    content = Buffer.from(`\ufeffcomplete\r\n${literal}\n🙂`)
    await act(async () =>
      root.render(
        createElement(MobileChatAttachmentPreview, { key: 'small', params: route.params })
      )
    )
    await vi.waitFor(async () => {
      await flush()
      expect(button('Copy').getAttribute('aria-disabled')).not.toBe('true')
      const row = Array.from(
        container.querySelectorAll('[data-testid="attachment-text-segment"]')
      ).find((node) => node.textContent === literal)
      if (!(row instanceof HTMLElement)) {
        throw new Error('Missing literal indented text row')
      }
      expect(getComputedStyle(row).whiteSpace).toBe('pre')
    })
    await act(async () => button('Copy').click())
    expect(mocks.write).toHaveBeenCalledWith(content.toString('utf8'))
    content = Buffer.from('"'.repeat(400_000))
    await act(async () =>
      root.render(
        createElement(MobileChatAttachmentPreview, { key: 'escaped', params: route.params })
      )
    )
    await vi.waitFor(async () => {
      await flush()
      expect(button('Copy').getAttribute('aria-disabled')).not.toBe('true')
    })
    await act(async () => button('Copy').click())
    expect(container.textContent).toContain(
      'Full Copy for this attachment needs the upcoming phone update.'
    )
    expect(mocks.write).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve()
    try {
      await act(async () => root.unmount())
    } finally {
      container.remove()
      sourceBlocks.mockRestore()
      rect.mockRestore()
      for (const [name, descriptor] of descriptors) {
        if (descriptor) {
          Object.defineProperty(HTMLElement.prototype, name, descriptor)
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, name)
        }
      }
      vi.unstubAllGlobals()
    }
  }
})
