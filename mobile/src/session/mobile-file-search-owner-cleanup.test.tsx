import { createElement, StrictMode, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
    Pressable: 'Pressable',
    Keyboard: { dismiss: vi.fn() },
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    SectionList: (await import('../test-support/section-list-test-double')).SectionListTestDouble,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  ImagePlus: 'ImagePlus',
  Mic: 'Mic',
  Square: 'Square',
  X: 'X'
}))
vi.mock('../components/BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
      visible ? React.createElement('BottomDrawer', { visible }, children) : null
  }
})

type Reply = Awaited<ReturnType<RpcClient['sendRequest']>>
const missing: Reply = {
  id: 'search',
  ok: false,
  error: { code: 'method_not_found', message: 'legacy host' },
  _meta: { runtimeId: 'legacy' }
}
const inventory: Reply = {
  id: 'list',
  ok: true,
  result: { files: [{ relativePath: 'src/apple.ts' }] },
  _meta: { runtimeId: 'legacy' }
}
const searchCall = [
  'files.searchPaths',
  {
    worktree: 'id:folder:remote',
    query: 'apple',
    limit: 16
  }
]
function pendingReply() {
  let resolve: (reply: Reply) => void = () => {
    throw new Error('uninitialized reply')
  }
  const promise = new Promise<Reply>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
function mount(sendRequest: RpcClient['sendRequest'], strict = false, getGeneration = () => 1) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The actual hook only reads these two RPC members at the fake transport boundary.
  const client = { sendRequest, getGeneration } as RpcClient
  let search: ReturnType<typeof useMobileNativeChatFileSearch> | undefined
  function Route({ showChat }: { showChat: boolean }) {
    search = useMobileNativeChatFileSearch({ client, worktreeId: 'folder:remote' })
    return showChat
      ? createElement(MobileNativeChatComposer, {
          value: '@apple',
          onChangeText: vi.fn(),
          onSend: async () => false,
          sendSurfaceId: 'remote-chat',
          getSendCompletionGeneration: () => 0,
          getComposerEditGeneration: () => 0,
          filePaths: search.nativeChatFilePaths,
          onNeedFiles: search.loadNativeChatFiles
        })
      : null
  }
  const element = (showChat: boolean) =>
    strict
      ? createElement(StrictMode, null, createElement(Route, { showChat }))
      : createElement(Route, { showChat })
  let renderer: ReturnType<typeof create> | undefined
  act(() => {
    renderer = create(element(false))
  })
  if (!renderer || !search) {
    throw new Error('actual route hook did not mount')
  }
  const view = renderer
  return {
    query: () =>
      act(() => {
        search?.loadNativeChatFiles('apple')
      }),
    showChat: () =>
      act(() => {
        view.update(element(true))
      }),
    triggerComposer: () =>
      act(() => {
        view.root
          .find((node) => typeof node.props.onSelectionChange === 'function')
          .props.onSelectionChange({ nativeEvent: { selection: { end: 6 } } })
      }),
    hideChat: () =>
      act(() => {
        view.update(element(false))
      }),
    paths: () => search?.nativeChatFilePaths,
    dispose: () =>
      act(() => {
        view.unmount()
      })
  }
}
async function debounce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120)
  })
}
async function refuse(search: ReturnType<typeof pendingReply>): Promise<void> {
  await act(async () => {
    search.resolve(missing)
    await search.promise
  })
}
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it.each([false, true])(
  'a disposed actual composer owner admits no new inventory; StrictMode=%s',
  async (strict) => {
    const search = pendingReply()
    const send = vi.fn<RpcClient['sendRequest']>((method) =>
      method === 'files.searchPaths' ? search.promise : Promise.resolve(inventory)
    )
    const view = mount(send, strict)
    view.showChat()
    view.triggerComposer()
    await debounce()
    expect(send.mock.calls).toEqual([searchCall])
    view.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await refuse(search)
    expect(send.mock.calls.filter(([method]) => method === 'files.searchPaths')).toHaveLength(1)
    expect(send.mock.calls.filter(([method]) => method === 'files.list')).toHaveLength(0)
  }
)

it.each([false, true])(
  'removing only the composer retains live fallback and cache; StrictMode=%s',
  async (strict) => {
    const search = pendingReply()
    const send = vi.fn<RpcClient['sendRequest']>((method) =>
      method === 'files.searchPaths' ? search.promise : Promise.resolve(inventory)
    )
    const view = mount(send, strict)
    view.showChat()
    view.triggerComposer()
    await debounce()
    expect(send.mock.calls).toEqual([searchCall])
    view.hideChat()
    await refuse(search)
    expect(send.mock.calls).toEqual([searchCall, ['files.list', { worktree: 'id:folder:remote' }]])
    expect(view.paths()).toEqual(['src/apple.ts'])
    view.showChat()
    view.triggerComposer()
    await debounce()
    expect(view.paths()).toEqual(['src/apple.ts'])
    expect(send).toHaveBeenCalledTimes(2)
    view.dispose()
  }
)

it('64 retired actual hooks do not start 64 whole-workspace reads', async () => {
  const pending = Array.from({ length: 64 }, pendingReply)
  let index = 0
  const send = vi.fn<RpcClient['sendRequest']>((method) =>
    method === 'files.searchPaths' ? pending[index++]!.promise : Promise.resolve(inventory)
  )
  for (let owner = 0; owner < pending.length; owner++) {
    const view = mount(send)
    view.query()
    await debounce()
    view.dispose()
  }
  expect(send.mock.calls).toEqual(pending.map(() => searchCall))
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => {
    pending.forEach((reply) => reply.resolve(missing))
    await Promise.all(pending.map((reply) => reply.promise))
  })
  expect(send.mock.calls.filter(([method]) => method === 'files.list')).toHaveLength(0)
})

it.each([false, true])(
  'a same-client successor owns its live fallback; StrictMode=%s',
  async (strict) => {
    const retiredSearch = pendingReply()
    let searches = 0
    const send = vi.fn<RpcClient['sendRequest']>((method) =>
      method === 'files.searchPaths'
        ? ++searches === 1
          ? retiredSearch.promise
          : Promise.resolve(missing)
        : Promise.resolve(inventory)
    )
    const retired = mount(send, strict)
    retired.query()
    await debounce()
    retired.dispose()
    const successor = mount(send, strict)
    successor.query()
    await debounce()
    expect(successor.paths()).toEqual(['src/apple.ts'])
    expect(send.mock.calls).toEqual([
      searchCall,
      searchCall,
      ['files.list', { worktree: 'id:folder:remote' }]
    ])
    await refuse(retiredSearch)
    expect(successor.paths()).toEqual(['src/apple.ts'])
    expect(send.mock.calls.filter(([method]) => method === 'files.list')).toHaveLength(1)
    successor.dispose()
  }
)

it('reentrant disposal after fallback entry preserves the admitted inventory', async () => {
  const search = pendingReply()
  let disposal: (() => void) | undefined
  const send = vi.fn<RpcClient['sendRequest']>((method) =>
    method === 'files.searchPaths' ? search.promise : Promise.resolve(inventory)
  )
  const view = mount(send, false, () => {
    disposal?.()
    return 1
  })
  view.query()
  await debounce()
  expect(send.mock.calls).toEqual([searchCall])
  disposal = view.dispose
  await refuse(search)
  expect(send.mock.calls).toEqual([searchCall, ['files.list', { worktree: 'id:folder:remote' }]])
})

it('already admitted inventory still settles after full owner disposal', async () => {
  const list = pendingReply()
  const send = vi.fn<RpcClient['sendRequest']>((method) =>
    method === 'files.searchPaths' ? Promise.resolve(missing) : list.promise
  )
  const view = mount(send)
  view.query()
  await debounce()
  expect(send.mock.calls).toEqual([searchCall, ['files.list', { worktree: 'id:folder:remote' }]])
  view.dispose()
  await act(async () => {
    list.resolve(inventory)
    await list.promise
  })
  expect(send.mock.calls).toEqual([searchCall, ['files.list', { worktree: 'id:folder:remote' }]])
  expect(vi.getTimerCount()).toBe(0)
})
