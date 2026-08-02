import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useMobileNativeChatTextExpansion,
  type MobileNativeChatTextExpansion
} from './use-mobile-native-chat-text-expansion'

const first = { capability: 'capability-first', originalChars: 5000 }
const second = { capability: 'capability-second', originalChars: 6000 }

describe('useMobileNativeChatTextExpansion', () => {
  let renderer: ReactTestRenderer | null = null
  let expansion: MobileNativeChatTextExpansion | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    expansion = null
  })

  function Harness({
    load,
    onExpand
  }: {
    load: () => Promise<string>
    onExpand?: () => void
  }): null {
    expansion = useMobileNativeChatTextExpansion(load, onExpand)
    return null
  }

  async function mount(load: () => Promise<string>, onExpand?: () => void): Promise<void> {
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { load, onExpand }))
      })
    } finally {
      restore()
    }
  }

  it('caches one full block and re-expands it without another read', async () => {
    const load = vi.fn().mockResolvedValue('full first')
    const onExpand = vi.fn()
    await mount(load, onExpand)

    await act(async () => {
      expansion?.toggle('message', first)
      await Promise.resolve()
    })
    expect(onExpand).toHaveBeenCalledOnce()
    expect(expansion?.cached?.text).toBe('full first')
    expect(expansion?.expandedKey).toBe(expansion?.cached?.key)

    act(() => expansion?.toggle('message', first))
    expect(expansion?.expandedKey).toBeNull()
    act(() => expansion?.toggle('message', first))

    expect(onExpand).toHaveBeenCalledTimes(2)
    expect(expansion?.expandedKey).toBe(expansion?.cached?.key)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('replaces the cache instead of retaining every expanded message', async () => {
    const load = vi.fn().mockResolvedValueOnce('full first').mockResolvedValueOnce('full second')
    await mount(load)
    await act(async () => {
      expansion?.toggle('message-1', first)
      await Promise.resolve()
    })
    await act(async () => {
      expansion?.toggle('message-2', second)
      await Promise.resolve()
    })

    expect(expansion?.cached).toMatchObject({ text: 'full second' })
    expect(JSON.stringify(expansion)).not.toContain('full first')
  })

  it('reuses the singleton display cache for copy without retaining other copied blocks', async () => {
    const load = vi.fn().mockResolvedValueOnce('full first').mockResolvedValueOnce('full second')
    await mount(load)
    await act(async () => {
      expansion?.toggle('message-1', first)
      await Promise.resolve()
    })

    await expect(expansion!.loadForCopy('message-1', first)).resolves.toBe('full first')
    await expect(expansion!.loadForCopy('message-1', second)).resolves.toBe('full second')

    expect(load).toHaveBeenCalledTimes(2)
    expect(expansion?.cached).toMatchObject({ text: 'full first' })
    expect(JSON.stringify(expansion)).not.toContain('full second')
  })

  it('serializes reads across distinct blocks', async () => {
    let resolveFirst: (text: string) => void = () => {}
    const load = vi.fn(() => new Promise<string>((resolve) => (resolveFirst = resolve)))
    await mount(load)

    act(() => {
      expansion?.toggle('message-1', first)
      expansion?.toggle('message-2', second)
    })

    expect(load).toHaveBeenCalledOnce()
    expect(expansion?.loadingKey).toBeTruthy()
    await act(async () => {
      resolveFirst('full first')
      await Promise.resolve()
    })
    act(() => expansion?.toggle('message-2', second))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('rejects copy retrieval while another full block is loading', async () => {
    let resolveFirst: (text: string) => void = () => {}
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce('full second')
    await mount(load)

    act(() => expansion?.toggle('message-1', first))
    await expect(expansion!.loadForCopy('message-2', second)).rejects.toThrow(
      'Another full message is loading'
    )
    expect(load).toHaveBeenCalledOnce()

    await act(async () => {
      resolveFirst('full first')
      await Promise.resolve()
    })
    await expect(expansion!.loadForCopy('message-2', second)).resolves.toBe('full second')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('clears retained text and ignores an old read when the session loader changes', async () => {
    let resolveFirst: (text: string) => void = () => {}
    const loadFirst = vi.fn(() => new Promise<string>((resolve) => (resolveFirst = resolve)))
    const loadSecond = vi.fn().mockResolvedValue('new session')
    await mount(loadFirst)
    act(() => expansion?.toggle('message-1', first))

    await act(async () => renderer?.update(createElement(Harness, { load: loadSecond })))
    await expect(expansion!.loadForCopy('message-2', second)).rejects.toThrow(
      'Another full message is loading'
    )
    await act(async () => {
      resolveFirst('stale session')
      await Promise.resolve()
    })

    expect(expansion?.cached).toBeNull()
    expect(expansion?.expandedKey).toBeNull()
    await expect(expansion!.loadForCopy('message-2', second)).resolves.toBe('new session')
  })
})

function suppressRendererWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}
