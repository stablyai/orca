import { describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame
} from '../../../../shared/browser-screencast-protocol'
import { isStreamingMethod, type RpcContext, type RpcMethod } from '../core'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'
import { MOBILE_WEB_BROWSER_STREAM_METHODS } from './mobile-web-browser-stream'

const subscribe = MOBILE_WEB_BROWSER_STREAM_METHODS.find(isStreamingMethod)!
const unsubscribe = MOBILE_WEB_BROWSER_STREAM_METHODS.find(
  (method) => !isStreamingMethod(method)
) as RpcMethod

const REQUEST = {
  worktree: 'id:workspace',
  page: 'page-1',
  format: 'jpeg' as const,
  quality: 72,
  maxWidth: 800,
  maxHeight: 600,
  everyNthFrame: 1,
  minFrameIntervalMs: 100
}

type ScreencastOptions = {
  emit: (event: unknown) => void
  sendBinary: (bytes: Uint8Array) => boolean | void
  signal?: AbortSignal
}

function fixture() {
  const cleanups = new Map<string, () => void>()
  let host!: ScreencastOptions
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = {
    browserScreencast: vi.fn(async (_params: unknown, options: ScreencastOptions) => {
      host = options
      release()
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener('abort', () => resolve())
      )
    }),
    registerSubscriptionCleanup: vi.fn((key: string, cleanup: () => void) =>
      cleanups.set(key, cleanup)
    ),
    cleanupSubscription: vi.fn((key: string) => cleanups.get(key)?.())
  }
  const events: unknown[] = []
  const context = { runtime, connectionId: 'connection' } as unknown as RpcContext
  const done = subscribe.handler(REQUEST, context, (event) => events.push(event))
  return {
    context,
    done,
    events,
    runtime,
    started,
    getHost: () => host
  }
}

function frameChunkOf(events: unknown[]) {
  return events.filter(
    (event): event is { type: string; data: string; chunkCount: number; frameSequence: number } =>
      typeof event === 'object' &&
      event !== null &&
      (event as { type?: string }).type === 'frameChunk'
  )
}

describe('host-owned browser screencast', () => {
  it('reports a startup failure before cleanup can end the stream', async () => {
    const cleanups = new Map<string, () => void>()
    const runtime = {
      browserScreencast: vi.fn().mockRejectedValue(new Error('Browser page not found')),
      registerSubscriptionCleanup: (key: string, cleanup: () => void) => cleanups.set(key, cleanup),
      cleanupSubscription: (key: string) => {
        cleanups.get(key)?.()
        cleanups.delete(key)
      }
    }
    const events: unknown[] = []
    await subscribe.handler(REQUEST, { runtime } as unknown as RpcContext, (event) =>
      events.push(event)
    )
    expect(events).toEqual([
      { type: 'ready', subscriptionId: expect.any(String) },
      { type: 'error', message: 'Browser stream failed.' }
    ])
    expect(cleanups.size).toBe(0)
  })

  it('announces the cancel id before any stream event', async () => {
    const f = fixture()
    await f.started

    expect(f.events[0]).toMatchObject({ type: 'ready' })
    expect(typeof (f.events[0] as { subscriptionId: string }).subscriptionId).toBe('string')
    expect(f.events[0]).not.toHaveProperty('tab')

    f.getHost().signal?.dispatchEvent(new Event('abort'))
    await f.done
  })

  it('strips the tab URL and bounds the title before the page sees it', async () => {
    const f = fixture()
    await f.started

    f.getHost().emit({
      type: 'ready',
      subscriptionId: 'browser-screencast:host',
      browserPageId: 'private-page',
      tab: {
        url: 'https://app.example/?session_token=secret&keep=1',
        title: 'x'.repeat(400),
        canGoBack: true,
        canGoForward: false
      }
    })

    expect(f.events[1]).toEqual({
      type: 'ready',
      tab: {
        url: 'https://app.example/?keep=1',
        title: 'x'.repeat(240),
        canGoBack: true,
        canGoForward: false
      }
    })
    expect(JSON.stringify(f.events)).not.toContain('private-page')
    f.getHost().signal?.dispatchEvent(new Event('abort'))
    await f.done
  })

  it('carries a binary frame across the JSON lane as base64 chunks', async () => {
    const f = fixture()
    await f.started

    f.getHost().sendBinary(
      encodeBrowserScreencastFrame({
        opcode: BrowserScreencastOpcode.Frame,
        seq: 7,
        format: 'jpeg',
        metadata: { imageWidth: 400, imageHeight: 300 },
        image: new Uint8Array([1, 2, 3, 4])
      })
    )

    const chunks = frameChunkOf(f.events)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ frameSequence: 7, chunkCount: 1, chunkIndex: 0 })
    expect(Buffer.from(chunks[0]!.data, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]))
    f.getHost().signal?.dispatchEvent(new Event('abort'))
    await f.done
  })

  it('ends the stream on a frame the page contract cannot describe', async () => {
    const f = fixture()
    await f.started

    f.getHost().sendBinary(
      encodeBrowserScreencastFrame({
        opcode: BrowserScreencastOpcode.Frame,
        seq: 1,
        format: 'jpeg',
        // Beyond the page contract's dimension bound.
        metadata: { imageWidth: 99_999 },
        image: new Uint8Array([9])
      })
    )

    expect(f.events.at(-1)).toEqual({
      type: 'error',
      message: 'Browser frame cannot be displayed safely.'
    })
    await f.done
    expect(f.events.filter((event) => (event as { type: string }).type === 'end')).toEqual([])
  })

  it('ends the page stream when the host cleanup for this connection runs', async () => {
    const f = fixture()
    await f.started
    const key = f.runtime.registerSubscriptionCleanup.mock.calls[0]![0] as string
    const subscriptionId = (f.events[0] as { subscriptionId: string }).subscriptionId

    expect(key).toBe(`mobileWeb.browser:connection:${subscriptionId}`)
    await unsubscribe.handler({ subscriptionId }, f.context)
    await f.done

    expect(f.events.at(-1)).toEqual({ type: 'end' })
  })

  it('releases its registration when the socket was already aborted', async () => {
    const abort = new AbortController()
    abort.abort()
    const cleanups = new Map<string, () => void>()
    const runtime = {
      browserScreencast: vi.fn(),
      registerSubscriptionCleanup: (key: string, cleanup: () => void) => cleanups.set(key, cleanup),
      cleanupSubscription: (key: string) => {
        cleanups.get(key)?.()
        cleanups.delete(key)
      }
    }
    const context = { runtime, signal: abort.signal } as unknown as RpcContext
    await subscribe.handler(REQUEST, context, () => {})
    expect(cleanups.size).toBe(0)
    expect(runtime.browserScreencast).not.toHaveBeenCalled()
  })

  it('exposes the stream and its cancel to the page lane', () => {
    expect(isMobileWebHostRpcMethod('mobileWeb.browser.subscribe')).toBe(true)
    expect(isMobileWebHostRpcMethod('mobileWeb.browser.unsubscribe')).toBe(true)
  })
})
