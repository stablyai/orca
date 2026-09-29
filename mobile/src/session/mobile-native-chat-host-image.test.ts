import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  isNativeChatCachedImagePath,
  NativeChatHostImageLoader,
  useNativeChatHostImage,
  type NativeChatImageLoad
} from './mobile-native-chat-host-image'

const HASH = 'a'.repeat(64)
const CACHED = `/Users/me/Library/Application Support/orca/native-chat-images/${HASH}.png`

/** The loader reaches only these members, so the rest of the client is a fake. */
type ImageClientParts = { sendRequest: unknown; getGeneration: () => number }

function fakeClient(sendRequest: unknown): RpcClient {
  const parts: ImageClientParts = { sendRequest, getGeneration: () => 0 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The loader calls `sendRequest` and `getGeneration` and nothing else on the client; every other member is unreachable from it.
  return parts as RpcClient
}

function imageReply(content: string): unknown {
  return {
    id: 'img',
    ok: true,
    result: { content, isBinary: true, isImage: true, mimeType: 'image/png' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function failure(code: string): unknown {
  return { id: 'img', ok: false, error: { code, message: code }, _meta: { runtimeId: 'r' } }
}

describe('isNativeChatCachedImagePath', () => {
  it('accepts only content-hash cache file names, on posix and windows hosts', () => {
    expect(isNativeChatCachedImagePath(CACHED)).toBe(true)
    expect(
      isNativeChatCachedImagePath(`C:\\Users\\me\\orca\\native-chat-images\\${HASH}.jpg`)
    ).toBe(true)
    expect(isNativeChatCachedImagePath('/tmp/screenshot.png')).toBe(false)
    expect(isNativeChatCachedImagePath(`/tmp/x${HASH}.png`)).toBe(false)
    expect(isNativeChatCachedImagePath(undefined)).toBe(false)
  })
})

describe('NativeChatHostImageLoader', () => {
  it('fetches a cached image once and returns a data: URI', async () => {
    const sendRequest = vi.fn().mockResolvedValue(imageReply('AAAA'))
    const loader = new NativeChatHostImageLoader(fakeClient(sendRequest))
    const [first, second] = await Promise.all([loader.load(CACHED), loader.load(CACHED)])
    expect(first).toEqual({ uri: 'data:image/png;base64,AAAA' })
    expect(second).toEqual(first)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0][0]).toBe('nativeChat.readImage')
  })

  it('never asks the host for a path outside its image cache', async () => {
    const sendRequest = vi.fn()
    const loader = new NativeChatHostImageLoader(fakeClient(sendRequest))
    await expect(loader.load('/tmp/pasted.png')).resolves.toEqual({ uri: null, retry: false })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('stops asking a host that predates nativeChat.readImage', async () => {
    const sendRequest = vi.fn().mockResolvedValue(failure('method_not_found'))
    const loader = new NativeChatHostImageLoader(fakeClient(sendRequest))
    await expect(loader.load(CACHED)).resolves.toEqual({ uri: null, retry: false })
    await expect(loader.load(CACHED.replace('.png', '.jpg'))).resolves.toEqual({
      uri: null,
      retry: false
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('retries a path after a transient refusal', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(failure('runtime_unavailable'))
      .mockResolvedValueOnce(imageReply('BBBB'))
    const loader = new NativeChatHostImageLoader(fakeClient(sendRequest))
    await expect(loader.load(CACHED)).resolves.toEqual({ uri: null, retry: true })
    await expect(loader.load(CACHED)).resolves.toEqual({ uri: 'data:image/png;base64,BBBB' })
  })

  it('does not re-ask for an image the host refused as too large', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      id: 'img',
      ok: false,
      error: { code: 'runtime_error', message: 'file_too_large' },
      _meta: { runtimeId: 'r' }
    })
    const loader = new NativeChatHostImageLoader(fakeClient(sendRequest))
    await expect(loader.load(CACHED)).resolves.toEqual({ uri: null, retry: false })
    await expect(loader.load(CACHED)).resolves.toEqual({ uri: null, retry: false })
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
})

describe('NativeChatHostImageLoader byte budget', () => {
  it('evicts the least-recent image once the cached data exceeds the byte budget', async () => {
    const big = 'A'.repeat(10 * 1024 * 1024)
    const sendRequest = vi.fn().mockResolvedValue(imageReply(big))
    const loader = new NativeChatHostImageLoader(fakeClient(sendRequest))
    const paths = ['1', '2', '3'].map((n) => CACHED.replace(HASH, n.repeat(64)))
    for (const path of paths) {
      await loader.load(path)
    }
    expect(sendRequest).toHaveBeenCalledTimes(3)

    await loader.load(paths[2])
    expect(sendRequest).toHaveBeenCalledTimes(3)
    await loader.load(paths[0])
    expect(sendRequest).toHaveBeenCalledTimes(4)
  })
})

describe('useNativeChatHostImage', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-asks a still-mounted row after a transient refusal', async () => {
    vi.useFakeTimers()
    const load = vi
      .fn<NativeChatImageLoad>()
      .mockResolvedValueOnce({ uri: null, retry: true })
      .mockResolvedValueOnce({ uri: 'data:image/png;base64,CCCC' })
    let uri: string | null = null
    function Harness(): null {
      uri = useNativeChatHostImage(CACHED, load)
      return null
    }
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(uri).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(load).toHaveBeenCalledTimes(2)
    expect(uri).toBe('data:image/png;base64,CCCC')
    act(() => renderer?.unmount())
  })

  it('does not re-ask after a settled refusal', async () => {
    vi.useFakeTimers()
    const load = vi.fn<NativeChatImageLoad>().mockResolvedValue({ uri: null, retry: false })
    function Harness(): null {
      useNativeChatHostImage(CACHED, load)
      return null
    }
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(load).toHaveBeenCalledTimes(1)
    act(() => renderer?.unmount())
  })
})
