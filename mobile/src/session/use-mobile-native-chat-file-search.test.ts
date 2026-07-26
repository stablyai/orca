import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  retainMobileNativeChatFilePaths,
  useMobileNativeChatFileSearch
} from './use-mobile-native-chat-file-search'

type SearchState = ReturnType<typeof useMobileNativeChatFileSearch>

function rpcSuccess(files: string[]): Awaited<ReturnType<RpcClient['sendRequest']>> {
  return {
    id: 'files',
    ok: true,
    result: { files: files.map((relativePath) => ({ relativePath })) },
    _meta: { runtimeId: 'runtime-1' }
  }
}

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

describe('useMobileNativeChatFileSearch', () => {
  let renderer: ReactTestRenderer | null = null
  let state: SearchState | null = null

  async function mount(client: RpcClient): Promise<void> {
    function Harness(): null {
      state = useMobileNativeChatFileSearch({ client, worktreeId: 'wt-1' })
      return null
    }
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(createElement(Harness))
      })
    } finally {
      restore()
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    state = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('coalesces rapid queries and retains only the bounded host result', async () => {
    const sendRequest = vi.fn().mockResolvedValue(rpcSuccess(['src/app.ts', 'src/app.test.ts']))
    await mount({ sendRequest } as unknown as RpcClient)

    act(() => {
      state?.loadNativeChatFiles('a')
      state?.loadNativeChatFiles('app')
    })
    await act(async () => vi.advanceTimersByTimeAsync(119))
    expect(sendRequest).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledWith('files.searchPaths', {
      worktree: 'id:wt-1',
      query: 'app',
      limit: 16
    })
    expect(state?.nativeChatFilePaths).toEqual(['src/app.ts', 'src/app.test.ts'])
  })

  it('loads the legacy inventory once when an older host lacks searchPaths', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'files.searchPaths') {
        return {
          id: 'missing',
          ok: false as const,
          error: { code: 'method_not_found', message: 'Unknown method' },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      return rpcSuccess(['src/apple.ts', 'docs/readme.md'])
    })
    await mount({ sendRequest } as unknown as RpcClient)

    act(() => state?.loadNativeChatFiles('apple'))
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(state?.nativeChatFilePaths).toEqual(['src/apple.ts'])

    act(() => state?.loadNativeChatFiles('readme'))
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(state?.nativeChatFilePaths).toEqual(['docs/readme.md'])
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'files.searchPaths',
      'files.list'
    ])
  })

  it('cancels an in-flight query on a cache hit so a stale result cannot clobber it', async () => {
    const sendRequest = vi.fn(async (_method: string, params: { query: string }) =>
      rpcSuccess(params.query === 'app' ? ['src/app.ts'] : ['src/beta.ts'])
    )
    await mount({ sendRequest } as unknown as RpcClient)

    // Populate the cache for 'app'.
    act(() => state?.loadNativeChatFiles('app'))
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(state?.nativeChatFilePaths).toEqual(['src/app.ts'])

    // Schedule 'beta' (debounced, unresolved), then hit the cache for 'app'.
    act(() => {
      state?.loadNativeChatFiles('beta')
      state?.loadNativeChatFiles('app')
    })
    expect(state?.nativeChatFilePaths).toEqual(['src/app.ts'])

    // The cancelled 'beta' request must never fire and overwrite the cached result.
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(state?.nativeChatFilePaths).toEqual(['src/app.ts'])
    expect(
      sendRequest.mock.calls.filter(([, params]) => (params as { query: string }).query === 'beta')
    ).toHaveLength(0)
  })

  it('coalesces overlapping legacy inventory requests on a slow host', async () => {
    let resolveList: (value: Awaited<ReturnType<RpcClient['sendRequest']>>) => void = () => {}
    const listResponse = new Promise<Awaited<ReturnType<RpcClient['sendRequest']>>>((resolve) => {
      resolveList = resolve
    })
    const sendRequest = vi.fn((method: string) => {
      if (method === 'files.searchPaths') {
        return Promise.resolve({
          id: 'missing',
          ok: false as const,
          error: { code: 'method_not_found', message: 'Unknown method' },
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      return listResponse
    })
    await mount({ sendRequest } as unknown as RpcClient)

    act(() => state?.loadNativeChatFiles('apple'))
    await act(async () => vi.advanceTimersByTimeAsync(120))
    act(() => state?.loadNativeChatFiles('readme'))
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(sendRequest.mock.calls.filter(([method]) => method === 'files.list')).toHaveLength(1)

    await act(async () => {
      resolveList(rpcSuccess(['src/apple.ts', 'docs/readme.md']))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(state?.nativeChatFilePaths).toEqual(['docs/readme.md'])
  })
})

describe('retainMobileNativeChatFilePaths', () => {
  it('accepts exact count and retained-byte limits and truncates at one over', () => {
    const result = {
      files: [{ relativePath: 'a' }, { relativePath: 'bb' }, { relativePath: 'ignored' }]
    }
    const exactBytes = 'a'.length * 2 + 64 + ('bb'.length * 2 + 64)

    expect(retainMobileNativeChatFilePaths(result, 2, exactBytes)).toEqual(['a', 'bb'])
    expect(retainMobileNativeChatFilePaths(result, 3, exactBytes - 1)).toEqual(['a'])
  })
})
