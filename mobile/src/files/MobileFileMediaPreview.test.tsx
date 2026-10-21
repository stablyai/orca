import { createElement, StrictMode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

type TestSink = {
  append: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}
const downloads = vi.hoisted((): { sinks: TestSink[] } => ({ sinks: [] }))
vi.mock('react-native', () => ({
  ActivityIndicator: 'Spinner',
  Pressable: 'Button',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('./MobileMediaPlayback', () => ({ MobileMediaPlayback: 'Player' }))
vi.mock('./mobile-media-preview-cache', () => ({
  createMobileMediaSink: () => {
    const sink = {
      append: vi.fn(),
      finish: vi.fn(() => `file:///media-${downloads.sinks.length}.mp4`),
      dispose: vi.fn()
    }
    downloads.sinks.push(sink)
    return sink
  }
}))
import { MobileFileMediaPreview } from './MobileFileMediaPreview'
import type { RpcResponse } from '../transport/types'

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  downloads.sinks = []
})
const media = { worktreeId: 'wt', relativePath: 'movie.mp4', mimeType: 'video/mp4' }
function ok(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}
const client = {
  sendRequest: async (method: string) =>
    ok(
      method === 'files.stat'
        ? { size: 3, isDirectory: false, mtime: 1 }
        : { contentBase64: 'AQID', bytesRead: 3, eof: true }
    )
}

describe('mobile media lifecycle', () => {
  it('survives Strict Mode replay and releases the active file when switching media', async () => {
    await act(async () => {
      tree = create(
        createElement(
          StrictMode,
          null,
          createElement(MobileFileMediaPreview, { media, client, title: 'Movie' })
        )
      )
    })
    if (!tree) {
      throw new Error('Player did not mount')
    }
    const rendered: ReactTestRenderer = tree
    expect(rendered.root.findAll((node) => String(node.type) === 'Player')).toHaveLength(1)
    const active = downloads.sinks.at(-1)
    expect(active?.finish).toHaveBeenCalledOnce()
    expect(active?.dispose).not.toHaveBeenCalled()
    await act(async () => {
      rendered.update(
        createElement(
          StrictMode,
          null,
          createElement(MobileFileMediaPreview, {
            media: { ...media, relativePath: 'music.mp3', mimeType: 'audio/mpeg' },
            client,
            title: 'Music'
          })
        )
      )
    })
    expect(active?.dispose).toHaveBeenCalled()
    act(() => rendered.unmount())
    tree = null
    expect(downloads.sinks.every((sink) => sink.dispose.mock.calls.length > 0)).toBe(true)
  })
  it('does not stage late bytes after the preview closes during download', async () => {
    let deliver: ((reply: RpcResponse) => void) | undefined
    const waiting = {
      sendRequest: vi.fn(
        async () =>
          new Promise<RpcResponse>((resolve) => {
            deliver = resolve
          })
      )
    }
    await act(async () => {
      tree = create(
        createElement(MobileFileMediaPreview, { media, client: waiting, title: 'Movie' })
      )
    })
    act(() => tree?.unmount())
    tree = null
    await act(async () => {
      deliver?.(ok({ size: 3, isDirectory: false, mtime: 1 }))
    })
    expect(waiting.sendRequest).toHaveBeenCalledOnce()
    expect(downloads.sinks[0]?.append).not.toHaveBeenCalled()
    expect(downloads.sinks[0]?.finish).not.toHaveBeenCalled()
    expect(downloads.sinks[0]?.dispose).toHaveBeenCalled()
  })
})
