// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MobileChatAttachmentPreview } from './MobileChatAttachmentPreview'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import type { RpcResponse } from '../transport/types'
import {
  AttachmentTextSource,
  ATTACHMENT_TEXT_PAGE_BYTES
} from '../../../src/shared/attachment-text-source'

vi.mock('react-native', () => vi.importActual<typeof import('react-native')>('react-native-web'))
vi.mock('../platform/text-input-font-size', () => import('../platform/text-input-font-size.web'))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 34 })
}))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'light' }))
const mocks = vi.hoisted(() => ({ send: vi.fn(), back: vi.fn(), write: vi.fn() }))
vi.mock('../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({ back: mocks.back })
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

it('commits actual RNweb blur and joins a begun navigation from the settled edited page', async () => {
  await activateMobileUiLocale('en')
  const content = Buffer.from('a\n'.repeat(ATTACHMENT_TEXT_PAGE_BYTES * 6))
  for (let page = 0; page < 12; page++) {
    content.write(
      `P${String(page + 1).padStart(2, '0')}-S1-L001 SECTIONTOP\n`,
      page * ATTACHMENT_TEXT_PAGE_BYTES
    )
  }
  const gate = Promise.withResolvers<void>()
  let held = false
  const offsets: number[] = []
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
        throw new Error('Expected range')
      }
      offsets.push(request.offset)
      if (held && request.offset === 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3) {
        await gate.promise
      }
      const chunk = content.subarray(request.offset, request.offset + request.length)
      return {
        id: 'r',
        ok: true,
        result: {
          snapshot: 'a'.repeat(64),
          size: content.length,
          bytesRead: chunk.length,
          contentBase64: chunk.toString('base64'),
          eof: request.offset + chunk.length === content.length
        }
      }
    }
  )
  const pageCalls = vi.spyOn(AttachmentTextSource.prototype, 'page')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const input = () => {
    const node = container.querySelector('input[aria-label="Attachment page"]')
    if (!(node instanceof HTMLInputElement)) {
      throw new Error('Expected actual RNweb input')
    }
    return node
  }
  const next = () => {
    const node = Array.from(container.querySelectorAll('[role="button"]')).find(
      (node) => node.textContent === 'Next'
    )
    if (!(node instanceof HTMLElement)) {
      throw new Error('Expected Next')
    }
    return node
  }
  const flush = () => act(async () => {})
  const ready = () =>
    vi.waitFor(async () => {
      await flush()
      expect(input().readOnly).toBe(false)
    })
  const edit = (value: string) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (!setter) {
        throw new Error('Expected DOM value setter')
      }
      setter.call(input(), value)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  const go = async (value: string) => {
    act(() => input().focus())
    edit(value)
    act(() => input().blur())
    await ready()
  }
  try {
    await act(async () =>
      root.render(
        createElement(MobileChatAttachmentPreview, {
          params: {
            hostId: 'owner',
            worktreeId: 'folder:work',
            source: 'chatAttachment',
            absolutePath:
              '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/report.txt'
          }
        })
      )
    )
    await ready()
    expect(input().style.fontSize).toBe('16px')
    expect(next().parentElement?.style.paddingBottom).toBe('34px')
    await go('5')
    const before = pageCalls.mock.calls.length
    const reads = offsets.slice()
    act(() => input().focus())
    for (const value of ['', '1', '12']) {
      edit(value)
      expect(input().value).toBe(value)
      expect(pageCalls).toHaveBeenCalledTimes(before)
      expect(offsets).toEqual(reads)
    }
    act(() =>
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
      )
    )
    expect(document.activeElement).toBe(input())
    expect(pageCalls).toHaveBeenCalledTimes(before)
    act(() => input().blur())
    await ready()
    expect(pageCalls.mock.calls.slice(before)).toEqual([[11, 0]])
    expect(input().value).toBe('12')
    expect(container.textContent).toContain('P12-S1-L001 SECTIONTOP')
    act(() => input().focus())
    edit('5')
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await vi.waitFor(async () => {
      await flush()
      expect(document.activeElement).not.toBe(input())
    })
    await ready()
    expect(input().value).toBe('5')
    await go('3')
    await go('5')
    const start = pageCalls.mock.calls.length
    held = true
    act(() => input().focus())
    edit('12')
    const button = next()
    expect(button.getAttribute('aria-disabled')).not.toBe('true')
    act(() =>
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }))
    )
    act(() => button.focus())
    expect(document.activeElement).toBe(button)
    expect(pageCalls.mock.calls.slice(start)).toEqual([[11, 0]])
    expect(button.getAttribute('aria-disabled')).not.toBe('true')
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }))
    })
    await vi.waitFor(async () => {
      await flush()
      expect(offsets.at(-1)).toBe(11 * ATTACHMENT_TEXT_PAGE_BYTES - 3)
    })
    expect(pageCalls.mock.calls.slice(start)).toEqual([[11, 0]])
    await act(async () => {
      held = false
      gate.resolve()
    })
    await ready()
    expect(pageCalls.mock.calls.slice(start)).toEqual([
      [11, 0],
      [11, 1]
    ])
    expect(input().value).toBe('12')
    expect(container.textContent).toContain('(2/32)')
    const unchanged = pageCalls.mock.calls.length
    act(() => input().focus())
    act(() => input().blur())
    expect(pageCalls).toHaveBeenCalledTimes(unchanged)
    expect(container.textContent).toContain('(2/32)')
    act(() => input().focus())
    edit('')
    edit('12')
    act(() => input().blur())
    await ready()
    expect(pageCalls.mock.calls.slice(unchanged)).toEqual([[11, 0]])
    expect(container.textContent).toContain('P12-S1-L001 SECTIONTOP')
    console.info(
      'PR35636 installed RNweb field',
      JSON.stringify({ calls: pageCalls.mock.calls, offsets })
    )
  } finally {
    gate.resolve()
    await act(async () => root.unmount())
    container.remove()
    pageCalls.mockRestore()
  }
})
