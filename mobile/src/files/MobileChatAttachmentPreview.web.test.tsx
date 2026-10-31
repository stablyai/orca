// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type * as ReactNative from 'react-native'
import { expect, it, vi } from 'vitest'
import { MobileChatAttachmentPreview } from './MobileChatAttachmentPreview'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import { publishShellKeyboardSource } from '../platform/keyboard-occlusion.web'
import type { RpcResponse } from '../transport/types'
import {
  AttachmentTextSource,
  ATTACHMENT_TEXT_PAGE_BYTES
} from '../../../src/shared/attachment-text-source'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))
vi.mock('../platform/text-input-font-size', () => import('../platform/text-input-font-size.web'))
vi.mock('../platform/keyboard-occlusion', () => import('../platform/keyboard-occlusion.web'))
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
  let gate = Promise.withResolvers<void>()
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
  const begin = (button: HTMLElement) => {
    const pointer = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 1
    })
    act(() => {
      if (button.dispatchEvent(pointer)) {
        button.focus()
      }
    })
    expect(pointer.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input())
    act(() => button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })))
    const mouse = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0
    })
    act(() => {
      if (button.dispatchEvent(mouse)) {
        button.focus()
      }
    })
    expect(mouse.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input())
  }
  const complete = (button: HTMLElement, detail = 1) =>
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail }))
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
    const readsBeforeStart = offsets.slice()
    begin(button)
    expect(pageCalls.mock.calls.slice(start)).toEqual([])
    expect(offsets).toEqual(readsBeforeStart)
    expect(button.getAttribute('aria-disabled')).not.toBe('true')
    complete(button)
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
    begin(next())
    expect(pageCalls).toHaveBeenCalledTimes(unchanged)
    complete(next())
    await ready()
    expect(pageCalls.mock.calls.slice(unchanged)).toEqual([[11, 2]])
    expect(container.textContent).toContain('(3/32)')
    const retyped = pageCalls.mock.calls.length
    act(() => input().focus())
    edit('')
    edit('12')
    act(() => input().blur())
    await ready()
    expect(pageCalls.mock.calls.slice(retyped)).toEqual([[11, 0]])
    expect(container.textContent).toContain('P12-S1-L001 SECTIONTOP')
    const plain = pageCalls.mock.calls.length
    complete(next(), 0)
    await ready()
    expect(pageCalls.mock.calls.slice(plain)).toEqual([[11, 1]])
    expect(container.textContent).toContain('(2/32)')
    await go('3')
    await go('5')
    gate = Promise.withResolvers<void>()
    held = true
    const busyStart = pageCalls.mock.calls.length
    act(() => input().focus())
    edit('12')
    const canceledReads = offsets.slice()
    begin(next())
    act(() => {
      next().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: -100 }))
      document.body.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 0, clientY: -100 })
      )
    })
    expect(document.activeElement).toBe(input())
    expect(pageCalls.mock.calls.slice(busyStart)).toEqual([])
    expect(offsets).toEqual(canceledReads)
    act(() => input().blur())
    await vi.waitFor(async () => {
      await flush()
      expect(next().getAttribute('aria-disabled')).toBe('true')
    })
    expect(pageCalls.mock.calls.slice(busyStart)).toEqual([[11, 0]])
    const busyMouse = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0
    })
    act(() => next().dispatchEvent(busyMouse))
    expect(busyMouse.defaultPrevented).toBe(false)
    complete(next())
    expect(pageCalls.mock.calls.slice(busyStart)).toEqual([[11, 0]])
    await act(async () => {
      held = false
      gate.resolve()
    })
    await ready()
    expect(pageCalls.mock.calls.slice(busyStart)).toEqual([[11, 0]])
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

it('lifts the focused pager only for reported keyboard occlusion and restores the closed safe area', async () => {
  await activateMobileUiLocale('en')
  const content = Buffer.from('a\n'.repeat(ATTACHMENT_TEXT_PAGE_BYTES * 6))
  const offsets: number[] = []
  mocks.send.mockReset()
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
  let height = 0
  const listeners = new Set<(height: number) => void>()
  publishShellKeyboardSource({
    read: () => height,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })
  const report = (nextHeight: number) =>
    act(() => {
      height = nextHeight
      for (const listener of listeners) {
        listener(height)
      }
    })
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
  const footer = () => {
    const node = input().parentElement
    if (!(node instanceof HTMLElement)) {
      throw new Error('Expected actual pager footer')
    }
    return node
  }
  const viewer = () => {
    const node = footer().parentElement
    if (!(node instanceof HTMLElement)) {
      throw new Error('Expected actual viewer frame')
    }
    return node
  }
  const layout = (lift: number, safeBottom: number) => {
    const row = getComputedStyle(footer())
    expect(row.flexDirection).toBe('row')
    expect(row.flexWrap).toBe('wrap')
    expect(row.minHeight).toBe('58px')
    expect(row.gap).toBe('12px')
    expect(viewer().style.paddingBottom).toBe(`${lift}px`)
    expect(footer().style.paddingBottom).toBe(`${safeBottom}px`)
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
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(input().readOnly).toBe(false)
    })
    const mountedInput = input()
    const initialCalls = pageCalls.mock.calls.slice()
    const initialReads = offsets.slice()
    layout(0, 34)
    report(300)
    layout(0, 0)
    act(() => input().focus())
    layout(300, 0)
    expect(document.activeElement).toBe(mountedInput)
    act(() => input().blur())
    layout(0, 0)
    expect(pageCalls.mock.calls).toEqual(initialCalls)
    expect(offsets).toEqual(initialReads)
    act(() => input().focus())
    layout(300, 0)
    for (const value of ['', '1', '12']) {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        if (!setter) {
          throw new Error('Expected DOM value setter')
        }
        setter.call(input(), value)
        input().dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(input().value).toBe(value)
      expect(pageCalls.mock.calls).toEqual(initialCalls)
      expect(offsets).toEqual(initialReads)
    }
    report(0)
    layout(0, 34)
    expect(input()).toBe(mountedInput)
    expect(document.activeElement).toBe(mountedInput)
    expect(input().value).toBe('12')
    expect(pageCalls.mock.calls).toEqual(initialCalls)
    expect(offsets).toEqual(initialReads)
  } finally {
    await act(async () => root.unmount())
    expect(listeners.size).toBe(0)
    publishShellKeyboardSource(null)
    container.remove()
    pageCalls.mockRestore()
  }
})

it.each([
  { action: 'Copy', mode: 'success' },
  { action: 'Copy', mode: 'failed' },
  { action: 'Retry', mode: 'retired' },
  { action: 'Back', mode: 'retired' },
  { action: 'First', mode: 'cached' },
  { action: 'Last', mode: 'failed' },
  { action: 'Next', mode: 'unmounted' }
])(
  'uses actual RNweb completion for $action and the same field operation ($mode)',
  async ({ action, mode }) => {
    const failed = mode === 'failed'
    await activateMobileUiLocale('en')
    const content = Buffer.from('a\n'.repeat(ATTACHMENT_TEXT_PAGE_BYTES * 6))
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    let held = false
    let rejected = false
    const offsets: number[] = []
    mocks.write.mockReset().mockResolvedValue(undefined)
    mocks.back.mockReset()
    mocks.send
      .mockReset()
      .mockImplementation(
        async (
          method: string,
          request?: { offset: number; length: number }
        ): Promise<RpcResponse> => {
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
          offsets.push(request.offset)
          if (held && request.offset === 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3) {
            started.resolve()
            await gate.promise
            if (failed && !rejected) {
              rejected = true
              throw new Error('field read failed')
            }
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
    const calls = vi.spyOn(AttachmentTextSource.prototype, 'page')
    const copied = vi.spyOn(AttachmentTextSource.prototype, 'copyText')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let unmounted = false
    const input = () => {
      const node = container.querySelector('input[aria-label="Attachment page"]')
      if (!(node instanceof HTMLInputElement)) {
        throw new Error('Expected actual RNweb input')
      }
      return node
    }
    const button = () => {
      const node = Array.from(container.querySelectorAll('[role="button"]')).find(
        (node) => node.textContent === action
      )
      if (!(node instanceof HTMLElement)) {
        throw new Error('Expected existing action')
      }
      return node
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
      await vi.waitFor(async () => {
        await act(async () => {})
        expect(input().readOnly).toBe(false)
      })
      const owner = calls.mock.contexts.at(-1)
      if (!(owner instanceof AttachmentTextSource)) {
        throw new Error('Expected actual source owner')
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (!setter) {
        throw new Error('Expected DOM input value setter')
      }
      const edit = (value: string) =>
        act(() => {
          setter.call(input(), value)
          input().dispatchEvent(new Event('input', { bubbles: true }))
        })
      if (mode === 'cached') {
        for (const page of ['12', '5']) {
          act(() => input().focus())
          edit(page)
          act(() => input().blur())
          await vi.waitFor(async () => {
            await act(async () => {})
            expect(input().readOnly).toBe(false)
          })
        }
      }
      const reads = offsets.slice()
      const count = calls.mock.calls.length
      act(() => input().focus())
      edit('12')
      held = true
      const node = button()
      const pointer = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        isPrimary: true,
        pointerType: 'touch',
        button: 0,
        buttons: 1
      })
      act(() => {
        if (node.dispatchEvent(pointer)) {
          node.focus()
        }
      })
      expect(pointer.defaultPrevented).toBe(true)
      const mouse = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 0
      })
      act(() => {
        if (node.dispatchEvent(mouse)) {
          node.focus()
        }
      })
      expect(mouse.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(input())
      expect(calls).toHaveBeenCalledTimes(count)
      expect(offsets).toEqual(reads)
      act(() => {
        node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }))
      })
      expect(calls.mock.calls.slice(count)[0]).toEqual([11, 0])
      expect(copied).not.toHaveBeenCalled()
      expect(mocks.write).not.toHaveBeenCalled()
      if (mode === 'unmounted') {
        await act(async () => {
          await started.promise
        })
        await act(async () => root.unmount())
        unmounted = true
        expect(owner.disposed).toBe(true)
      } else if (mode === 'success' || mode === 'failed') {
        await act(async () => {
          await started.promise
        })
        expect(offsets).toEqual([...reads, 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3])
      } else if (mode === 'retired') {
        await vi.waitFor(() => expect(owner.disposed).toBe(true))
        if (action === 'Back') {
          expect(mocks.back).toHaveBeenCalledOnce()
        } else {
          await vi.waitFor(async () => {
            await act(async () => {})
            expect(input().readOnly).toBe(false)
          })
          expect(calls.mock.contexts.at(-1)).not.toBe(owner)
          expect(input().value).toBe('1')
        }
      }
      await act(async () => {
        held = false
        gate.resolve()
      })
      if (action === 'First' || action === 'Last') {
        await vi.waitFor(async () => {
          await act(async () => {})
          expect(input().readOnly).toBe(false)
        })
        expect(calls.mock.calls.slice(count)).toEqual([
          [11, 0],
          action === 'First' ? [0, 0] : [11, Number.MAX_SAFE_INTEGER]
        ])
        expect(input().value).toBe(action === 'First' ? '1' : '12')
        expect(container.textContent).toContain(action === 'First' ? '(1/32)' : '(32/32)')
        if (mode === 'cached') {
          expect(offsets).toEqual([...reads, 0])
        }
      }
      if (mode === 'unmounted') {
        expect(calls.mock.calls.slice(count)).toEqual([[11, 0]])
        expect(container.childElementCount).toBe(0)
      }
      if (action === 'Copy') {
        await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledWith(content.toString('utf8')))
        expect(copied).toHaveBeenCalledOnce()
        expect(input().value).toBe(failed ? '1' : '12')
        const alerts = container.querySelectorAll('[role="alert"]')
        expect(alerts).toHaveLength(failed ? 1 : 0)
        if (failed) {
          expect(alerts[0]?.textContent).toBe('field read failed')
        }
      } else {
        expect(mocks.write).not.toHaveBeenCalled()
        if (action === 'Retry') {
          expect(input().value).toBe('1')
        }
      }
      console.info(
        'PR35636 RNweb control family',
        JSON.stringify({
          action,
          failed,
          calls: calls.mock.calls.slice(count),
          offsets,
          disposed: owner.disposed
        })
      )
    } finally {
      gate.resolve()
      if (!unmounted) {
        await act(async () => root.unmount())
      }
      container.remove()
      calls.mockRestore()
      copied.mockRestore()
    }
  }
)
