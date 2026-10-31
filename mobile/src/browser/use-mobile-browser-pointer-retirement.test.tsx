import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'
import { useMobileBrowserCommands } from './use-mobile-browser-commands'
import { useMobileBrowserRequest } from './use-mobile-browser-request'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const accepted: RpcResponse = { id: 'reply', ok: true, result: {} }
const refused: RpcResponse = {
  id: 'reply',
  ok: false,
  error: { code: 'unknown-method', message: 'Unknown method' }
}
type Commands = ReturnType<typeof useMobileBrowserCommands>
const renderers: ReactTestRenderer[] = []

afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount()
    }
  })
})

function mount(client: RpcClient) {
  let commands: Commands | null = null
  const errors: (string | null)[] = []
  function Screen({ currentClient }: { currentClient: RpcClient }) {
    const { pageParams, sendBrowserRequest } = useMobileBrowserRequest({
      busyRef: { current: false },
      client: currentClient,
      pageId: 'page',
      setBusy: () => {},
      setError: () => {},
      worktreeId: 'workspace'
    })
    commands = useMobileBrowserCommands({
      client: currentClient,
      pageParams,
      sendBrowserRequest,
      frameMetadataRef: { current: null },
      keyboardValue: '',
      layoutRef: { current: null },
      onToast: () => {},
      pointerModifiers: [],
      setDialog: () => {},
      setError: (value) => {
        if (typeof value !== 'function') {
          errors.push(value)
        }
      },
      setKeyboardValue: () => {},
      setPointerModifiers: () => {},
      zoomRef: { current: { scale: 1, offsetX: 0, offsetY: 0 } }
    })
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(Screen, { currentClient: client }))
  })
  renderers.push(renderer)
  return {
    get commands(): Commands {
      if (!commands) {
        throw new Error('not mounted')
      }
      return commands
    },
    errors,
    unmount: () => act(() => renderer.unmount()),
    replace: (currentClient: RpcClient) =>
      act(() => renderer.update(createElement(Screen, { currentClient })))
  }
}

describe('browser pointer commands after owner retirement', () => {
  it.each([8, 80])('does not drain scroll work for %i departed panes', async (owners) => {
    const move = deferred<RpcResponse>()
    const calls: string[] = []
    const client = stubRpcClient({
      sendRequest: async (method) => {
        calls.push(method)
        return method === 'browser.mouseMove' ? move.promise : accepted
      }
    })
    for (let index = 0; index < owners; index++) {
      const screen = mount(client)
      screen.commands.sendWheel({ x: 10, y: 20 }, 0, 10, index)
      screen.commands.sendWheel({ x: 10, y: 25 }, 0, 20, index)
      screen.unmount()
    }
    expect(calls).toEqual(Array.from({ length: owners }, () => 'browser.mouseMove'))
    await act(async () => {
      move.resolve(accepted)
      await move.promise
    })
    expect(calls).toHaveLength(owners)

    const liveCalls: { method: string; params: unknown }[] = []
    const live = mount(
      stubRpcClient({
        sendRequest: async (method, params) => {
          liveCalls.push({ method, params })
          return accepted
        }
      })
    )
    await act(async () => {
      live.commands.sendWheel({ x: 5, y: 6 }, 0, 30, 1)
    })
    expect(liveCalls).toEqual([
      {
        method: 'browser.mouseMove',
        params: { worktree: 'id:workspace', page: 'page', x: 5, y: 6 }
      },
      {
        method: 'browser.mouseWheel',
        params: { worktree: 'id:workspace', page: 'page', dx: 0, dy: -30 }
      }
    ])
    expect(live.errors).toEqual([null])
  })

  it('does not replay a late refused click after leaving the pane', async () => {
    const click = deferred<RpcResponse>()
    const calls: string[] = []
    const screen = mount(
      stubRpcClient({
        sendRequest: async (method) => {
          calls.push(method)
          return method === 'browser.mouseClick' ? click.promise : accepted
        }
      })
    )
    const pending = screen.commands.sendPointerClick({ x: 10, y: 20 }, 'left')
    screen.unmount()
    await act(async () => {
      click.resolve(refused)
      await pending
    })
    expect(calls).toEqual(['browser.mouseClick'])
    expect(screen.errors).toEqual([])
  })

  it('releases an already admitted mouse down after leaving the pane', async () => {
    const down = deferred<RpcResponse>()
    const calls: string[] = []
    const screen = mount(
      stubRpcClient({
        sendRequest: async (method) => {
          calls.push(method)
          if (method === 'browser.mouseClick') {
            return refused
          }
          return method === 'browser.mouseDown' ? down.promise : accepted
        }
      })
    )
    let pending!: Promise<void>
    await act(async () => {
      pending = screen.commands.sendPointerClick({ x: 10, y: 20 }, 'left')
    })
    expect(calls).toEqual(['browser.mouseClick', 'browser.mouseMove', 'browser.mouseDown'])
    screen.unmount()
    await act(async () => {
      down.resolve(accepted)
      await pending
    })
    expect(calls.at(-1)).toBe('browser.mouseUp')
    expect(screen.errors).toEqual([])
  })

  it('does not start a fallback press after its move outlives the pane', async () => {
    const move = deferred<RpcResponse>()
    const calls: string[] = []
    const screen = mount(
      stubRpcClient({
        sendRequest: async (method) => {
          calls.push(method)
          if (method === 'browser.mouseClick') {
            return refused
          }
          return method === 'browser.mouseMove' ? move.promise : accepted
        }
      })
    )
    let pending!: Promise<void>
    await act(async () => {
      pending = screen.commands.sendPointerClick({ x: 10, y: 20 }, 'left')
    })
    expect(calls).toEqual(['browser.mouseClick', 'browser.mouseMove'])
    screen.unmount()
    await act(async () => {
      move.resolve(accepted)
      await pending
    })
    expect(calls).toEqual(['browser.mouseClick', 'browser.mouseMove'])
  })

  it('lets a replacement client scroll without an old callback draining its queue', async () => {
    const oldMove = deferred<RpcResponse>()
    const oldCalls: string[] = []
    const screen = mount(
      stubRpcClient({
        sendRequest: async (method) => {
          oldCalls.push(method)
          return method === 'browser.mouseMove' ? oldMove.promise : accepted
        }
      })
    )
    screen.commands.sendWheel({ x: 1, y: 2 }, 0, 3, 1)
    const nextMove = deferred<RpcResponse>()
    const newCalls: { method: string; params: unknown }[] = []
    screen.replace(
      stubRpcClient({
        sendRequest: async (method, params) => {
          newCalls.push({ method, params })
          return method === 'browser.mouseMove' && newCalls.length === 1
            ? nextMove.promise
            : accepted
        }
      })
    )
    screen.commands.sendWheel({ x: 4, y: 5 }, 0, 6, 2)
    screen.commands.sendWheel({ x: 7, y: 8 }, 0, 9, 2)
    screen.commands.sendWheel({ x: 7, y: 8 }, 0, 12, 2)
    expect(newCalls.map(({ method }) => method)).toEqual(['browser.mouseMove'])
    await act(async () => {
      oldMove.resolve(accepted)
      await oldMove.promise
    })
    expect(oldCalls).toEqual(['browser.mouseMove'])
    expect(newCalls).toHaveLength(1)
    await act(async () => {
      nextMove.resolve(accepted)
      await nextMove.promise
    })
    expect(newCalls).toEqual([
      {
        method: 'browser.mouseMove',
        params: { worktree: 'id:workspace', page: 'page', x: 4, y: 5 }
      },
      {
        method: 'browser.mouseWheel',
        params: { worktree: 'id:workspace', page: 'page', dx: 0, dy: -6 }
      },
      {
        method: 'browser.mouseMove',
        params: { worktree: 'id:workspace', page: 'page', x: 7, y: 8 }
      },
      {
        method: 'browser.mouseWheel',
        params: { worktree: 'id:workspace', page: 'page', dx: 0, dy: -21 }
      }
    ])
  })
})
