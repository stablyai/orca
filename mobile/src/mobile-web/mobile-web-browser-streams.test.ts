import { describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebBrowserStreams } from './mobile-web-browser-streams'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web browser streams', () => {
  it('resolves opaque targets, chunks frames below the bridge limit, and cleans up', async () => {
    const randomBytes = (length: number): Uint8Array => new Uint8Array(length).fill(4)
    const workspaceAuthority = new MobileWebWorkspaceAuthority(randomBytes)
    workspaceAuthority.synchronize([{ workspaceId: 'host-workspace', repoId: 'repo-1' }])
    const workspaceId = workspaceAuthority.pageWorkspaceId('host-workspace')
    const browserAuthority = new MobileWebBrowserAuthority(randomBytes)
    const pageId = browserAuthority.register('host-workspace', 'raw-page')
    const postEvent = vi.fn(async () => {})
    let onEvent: ((event: unknown) => void) | undefined
    let onFrame: ((frame: BrowserScreencastFrame) => void) | undefined
    const unsubscribe = vi.fn()
    const subscribe = vi
      .fn<RpcClient['subscribe']>()
      .mockImplementation((_method, _payload, eventListener, options) => {
        onEvent = eventListener
        onFrame = options?.onBinaryFrame
        return unsubscribe
      })
    const streams = new MobileWebBrowserStreams({
      isActive: () => true,
      workspaceAuthority,
      browserAuthority,
      postEvent,
      postClosed: vi.fn()
    })

    streams.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      payload: {
        workspaceId,
        pageId,
        format: 'jpeg',
        quality: 72,
        maxWidth: 800,
        maxHeight: 600,
        everyNthFrame: 1,
        minFrameIntervalMs: 100
      },
      client: { subscribe } as unknown as RpcClient
    })

    expect(subscribe).toHaveBeenCalledWith(
      'browser.screencast',
      {
        worktree: 'id:host-workspace',
        page: 'raw-page',
        format: 'jpeg',
        quality: 72,
        maxWidth: 800,
        maxHeight: 600,
        everyNthFrame: 1,
        minFrameIntervalMs: 100
      },
      expect.any(Function),
      { onBinaryFrame: expect.any(Function) }
    )

    onEvent?.({
      type: 'ready',
      browserPageId: 'raw-page',
      tab: {
        url: 'https://example.com',
        title: 'Example',
        canGoBack: true,
        canGoForward: false,
        rawSecret: 'must-not-cross'
      }
    })
    onEvent?.({
      type: 'navigation',
      tab: {
        url: 'https://www.iana.org/help/example-domains',
        title: 'IANA-managed Reserved Domains',
        canGoBack: true,
        canGoForward: false
      }
    })
    const image = new Uint8Array(200_000).map((_, index) => index % 251)
    onFrame?.({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 7,
      format: 'jpeg',
      metadata: { deviceWidth: 800, deviceHeight: 600 },
      image
    })

    await vi.waitFor(() => expect(postEvent).toHaveBeenCalledTimes(4))
    expect(postEvent.mock.calls.map(([, sequence]) => sequence)).toEqual([0, 1, 2, 3])
    expect(postEvent.mock.calls[0]?.[2]).toEqual({
      type: 'ready',
      tab: {
        url: 'https://example.com',
        title: 'Example',
        canGoBack: true,
        canGoForward: false
      }
    })
    expect(postEvent.mock.calls[1]?.[2]).toEqual({
      type: 'navigation',
      tab: {
        url: 'https://www.iana.org/help/example-domains',
        title: 'IANA-managed Reserved Domains',
        canGoBack: true,
        canGoForward: false
      }
    })
    const chunks = postEvent.mock.calls.slice(2).map((call) => call[2])
    expect(chunks).toMatchObject([
      { type: 'frameChunk', frameSequence: 7, chunkIndex: 0, chunkCount: 2 },
      { type: 'frameChunk', frameSequence: 7, chunkIndex: 1, chunkCount: 2 }
    ])
    expect(JSON.stringify(chunks)).not.toContain('raw-page')

    expect(streams.cancel('subscription-1')).toBe('request-1')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
