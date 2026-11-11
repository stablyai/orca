import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'

type SearchState = ReturnType<typeof useMobileNativeChatFileSearch>

function rpcSuccess(files: string[]): Awaited<ReturnType<RpcClient['sendRequest']>> {
  return {
    id: 'files',
    ok: true,
    result: { files: files.map((relativePath) => ({ relativePath })) },
    _meta: { runtimeId: 'runtime-1' }
  }
}

type FileSearchClientParts = { sendRequest: unknown; getGeneration?: () => number }

function fakeClient(parts: FileSearchClientParts): RpcClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The hook calls `sendRequest` and `getGeneration` and nothing else on the client; every other member is unreachable from it.
  return parts as RpcClient
}

describe('useMobileNativeChatFileSearch', () => {
  let renderer: ReactTestRenderer | null = null
  let state: SearchState | null = null

  async function mount(client: RpcClient): Promise<void> {
    function Harness(): null {
      state = useMobileNativeChatFileSearch({ client, worktreeId: 'wt-1' })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    state = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('rejects an old authority response before it can populate the cache', async () => {
    let generation = 1
    let resolveOld: (reply: Awaited<ReturnType<RpcClient['sendRequest']>>) => void = () => {}
    const oldReply = new Promise<Awaited<ReturnType<RpcClient['sendRequest']>>>((resolve) => {
      resolveOld = resolve
    })
    const sendRequest = vi.fn(() =>
      generation === 1 ? oldReply : Promise.resolve(rpcSuccess(['new/apple.ts']))
    )
    await mount(fakeClient({ sendRequest, getGeneration: () => generation }))
    act(() => state?.loadNativeChatFiles('apple'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120)
    })
    generation = 2
    await act(async () => {
      resolveOld(rpcSuccess(['old/apple.ts']))
      await oldReply
    })
    expect(state?.nativeChatFilePaths).toEqual([])
    act(() => state?.loadNativeChatFiles('apple'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120)
    })
    expect(state?.nativeChatFilePaths).toEqual(['new/apple.ts'])
  })
})
