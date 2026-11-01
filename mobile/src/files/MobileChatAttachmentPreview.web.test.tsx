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
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      return new DOMRect(
        0,
        0,
        390,
        this.style.opacity === '0' ? 19 : Number.parseFloat(this.style.height) || 600
      )
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
        const box = { inlineSize: 390, blockSize: target.getBoundingClientRect().height }
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
  let content = Buffer.from('\n'.repeat(25 * 1024 * 1024) + 'TAIL')
  const sourceBlocks = vi.spyOn(AttachmentTextSource.prototype, 'block')
  const reads: { offset: number; length: number }[] = []
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
    await vi.waitFor(async () => {
      await flush()
      expect(reads.length).toBeGreaterThan(0)
    })
    expect(button('Copy').getAttribute('aria-disabled')).toBe('true')
    expect(button('Save').getAttribute('aria-disabled')).toBe('true')
    // Supply browser layout, not source results or callbacks; the real list owns scrolling and demand.
    const scroller = Array.from(container.querySelectorAll('div')).find((node) =>
      ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)
    )
    if (!(scroller instanceof HTMLElement)) {
      throw new Error('Expected actual RN-web scroll host')
    }
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 })
    const source = sourceBlocks.mock.contexts.at(-1)
    if (!(source instanceof AttachmentTextSource)) {
      throw new Error('Expected actual source identity')
    }
    const { AttachmentTextViewport } = await import('../../../src/shared/attachment-text-viewport')
    const track = new AttachmentTextViewport(source, 19, 600)
    await act(async () => {
      scroller.scrollTop = track.total - 600
      scroller.dispatchEvent(new Event('scroll'))
    })
    await vi.waitFor(async () => {
      await flush()
      expect(container.textContent).toContain('TAIL')
    })
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(reads.every((request) => request.length <= 16 * 1024)).toBe(true)
    expect(
      container.querySelectorAll('[data-testid="attachment-text-segment"]').length
    ).toBeGreaterThan(0)
    expect(
      container.querySelectorAll('[data-testid="attachment-text-segment"]').length
    ).toBeLessThanOrEqual(256)
    await act(async () => {
      scroller.scrollTop = 0
      scroller.dispatchEvent(new Event('scroll'))
    })
    await act(async () => button('Back').click())
    expect(mocks.back).toHaveBeenCalledOnce()
    content = Buffer.from('\ufeffcomplete\r\n🙂')
    await act(async () =>
      root.render(
        createElement(MobileChatAttachmentPreview, { key: 'small', params: route.params })
      )
    )
    await vi.waitFor(async () => {
      await flush()
      expect(button('Copy').getAttribute('aria-disabled')).not.toBe('true')
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
    await act(async () => root.unmount())
    container.remove()
    sourceBlocks.mockRestore()
    rect.mockRestore()
    vi.unstubAllGlobals()
  }
})
