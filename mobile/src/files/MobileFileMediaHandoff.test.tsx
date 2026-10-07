import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import { MobileFileMediaHandoff } from './MobileFileMediaHandoff'
import { createMobileFileMediaAttempt } from './mobile-file-media-handoff'
import { mediaHandoffCacheName, mediaHandoffSinkFor } from './mobile-file-media-handoff-device'

type FileWrite = { content: string; options: { encoding?: string; append?: boolean } | undefined }

const doubles = vi.hoisted(() => ({
  shared: new Array<{ uri: string; options: Record<string, unknown> }>(),
  shareRejects: false,
  preexisting: new Set<string>(),
  deleted: new Array<string>(),
  writes: new Map<string, FileWrite[]>()
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ ExternalLink: 'ExternalLink' }))
vi.mock('expo-sharing', () => ({
  shareAsync: (uri: string, options: Record<string, unknown>) => {
    doubles.shared.push({ uri, options })
    return doubles.shareRejects ? Promise.reject(new Error('no share target')) : Promise.resolve()
  }
}))
vi.mock('expo-file-system', () => ({
  File: class {
    readonly uri: string
    constructor(...parts: string[]) {
      this.uri = parts.join('/')
    }
    get exists(): boolean {
      return doubles.preexisting.has(this.uri)
    }
    write(content: string, options?: { encoding?: string; append?: boolean }): void {
      const writes = doubles.writes.get(this.uri) ?? []
      writes.push({ content, options })
      doubles.writes.set(this.uri, writes)
      doubles.preexisting.add(this.uri)
    }
    delete(): void {
      doubles.deleted.push(this.uri)
      doubles.preexisting.delete(this.uri)
    }
  },
  Paths: { cache: 'file:///cache' }
}))

function ok(result: unknown): RpcSuccess {
  return { id: '1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function fail(message: string, code = 'error'): RpcFailure {
  return { id: '1', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

function clientWithResponses(responses: RpcResponse[]) {
  return {
    sendRequest: vi.fn(async () => responses.shift()!)
  }
}

function byName(tree: ReactTestRenderer, name: string): ReactTestInstance[] {
  return tree.root.findAll((node) => String(node.type) === name)
}

function texts(tree: ReactTestRenderer): string[] {
  return byName(tree, 'Text').flatMap((node) =>
    node.children.filter((child): child is string => typeof child === 'string')
  )
}

function openButton(tree: ReactTestRenderer): ReactTestInstance | undefined {
  return byName(tree, 'Pressable').find((node) => node.props.onPress !== undefined)
}

function render(overrides: Partial<Parameters<typeof MobileFileMediaHandoff>[0]> = {}) {
  const client = overrides.client ?? clientWithResponses([])
  const tree: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    tree.tree = create(
      createElement(MobileFileMediaHandoff, {
        client,
        connected: true,
        mimeType: 'application/pdf',
        relativePath: 'docs/report.pdf',
        title: 'report.pdf',
        worktreeId: 'wt-1',
        ...overrides
      })
    )
  })
  if (tree.tree === null) {
    throw new Error('the handoff did not render')
  }
  return tree.tree
}

describe('the cache sink', () => {
  it('names the download after the basename and nothing exotic in it', () => {
    expect(mediaHandoffCacheName('wt-1', 'docs/my report (1).pdf')).toMatch(
      /^orca-media-handoff-[0-9a-f]{8}-my_report__1_\.pdf$/
    )
    expect(mediaHandoffCacheName('wt-1', 'videos/clip.MP4')).toMatch(
      /^orca-media-handoff-[0-9a-f]{8}-clip\.MP4$/
    )
  })

  it('keys the name on the workspace as well as the path, so equal paths do not collide', () => {
    const first = mediaHandoffCacheName('wt-alpha', 'docs/report.pdf')
    const second = mediaHandoffCacheName('wt-beta', 'docs/report.pdf')

    expect(first).not.toBe(second)
    // Stable for the same source, so open()'s delete-then-rewrite lands on the same file.
    expect(mediaHandoffCacheName('wt-alpha', 'docs/report.pdf')).toBe(first)
  })

  it('opens over a stale copy and appends every chunk as base64', () => {
    doubles.preexisting.clear()
    doubles.deleted.length = 0
    doubles.writes.clear()
    const name = mediaHandoffCacheName('wt-1', 'docs/report.pdf')
    const uri = `file:///cache/${name}`
    doubles.preexisting.add(uri)

    const sink = mediaHandoffSinkFor('wt-1', 'docs/report.pdf')
    expect(sink.uri).toBe(uri)
    const firstAttempt = createMobileFileMediaAttempt()
    sink.open(firstAttempt)
    expect(doubles.deleted).toEqual([uri])
    sink.appendBase64('AAA=', firstAttempt)
    sink.appendBase64('QQ==', firstAttempt)
    expect(doubles.writes.get(uri)).toEqual([
      { content: 'AAA=', options: { encoding: 'base64', append: true } },
      { content: 'QQ==', options: { encoding: 'base64', append: true } }
    ])
    sink.discard(firstAttempt)
    expect(doubles.deleted).toHaveLength(2)
  })

  it('releases a completed owner while retaining the file for sharing', () => {
    doubles.preexisting.clear()
    doubles.deleted.length = 0
    doubles.writes.clear()
    const sink = mediaHandoffSinkFor('wt-1', 'docs/report.pdf')
    const attempt = createMobileFileMediaAttempt()

    sink.open(attempt)
    sink.appendBase64('AAA=', attempt)
    sink.release(attempt)
    attempt.cancel()
    sink.discard(attempt)

    expect(doubles.preexisting.has(sink.uri)).toBe(true)
    expect(doubles.deleted).toEqual([])
  })

  it('isolates same-path sink instances so an old attempt cannot delete the new cache', () => {
    doubles.preexisting.clear()
    doubles.deleted.length = 0
    doubles.writes.clear()
    const firstSink = mediaHandoffSinkFor('wt-1', 'docs/report.pdf')
    const secondSink = mediaHandoffSinkFor('wt-1', 'docs/report.pdf')
    const firstAttempt = createMobileFileMediaAttempt()
    const secondAttempt = createMobileFileMediaAttempt()
    doubles.preexisting.add(firstSink.uri)
    firstSink.open(firstAttempt)
    firstSink.appendBase64('OLD=', firstAttempt)
    secondSink.open(secondAttempt)
    firstAttempt.cancel()
    firstSink.discard(firstAttempt)
    secondSink.appendBase64('NEW=', secondAttempt)
    expect(doubles.writes.get(firstSink.uri)).toEqual([
      { content: 'OLD=', options: { encoding: 'base64', append: true } },
      { content: 'NEW=', options: { encoding: 'base64', append: true } }
    ])
    expect(doubles.deleted).toHaveLength(2)
    secondSink.discard(secondAttempt)
    expect(doubles.deleted).toHaveLength(3)
  })
})

describe('a PDF the phone hands to the OS', () => {
  it('downloads it chunk-by-chunk and hands the cached file to the share sheet', async () => {
    doubles.shared.length = 0
    doubles.shareRejects = false
    const firstChunk = Buffer.alloc(524288, 0xa5).toString('base64')
    const finalChunk = Buffer.alloc(16, 0x5a).toString('base64')
    const client = clientWithResponses(
      [
        { contentBase64: firstChunk, bytesRead: 524288, eof: false },
        { contentBase64: finalChunk, bytesRead: 16, eof: true }
      ].map(ok)
    )
    const tree = render({ client })

    await act(async () => {
      openButton(tree)?.props.onPress()
    })

    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.readChunk',
      {
        worktree: 'id:wt-1',
        relativePath: 'docs/report.pdf',
        offset: 0,
        length: 524288
      },
      { failWhenDisconnected: true, timeoutMs: 30_000 }
    )
    expect(doubles.shared).toEqual([
      {
        uri: `file:///cache/${mediaHandoffCacheName('wt-1', 'docs/report.pdf')}`,
        options: { mimeType: 'application/pdf', dialogTitle: 'Open report.pdf' }
      }
    ])
  })

  it('shows download progress while the screen stays mounted', async () => {
    const resolvers: ((response: RpcResponse) => void)[] = []
    const client = {
      sendRequest: vi.fn(() => new Promise<RpcResponse>((resolve) => resolvers.push(resolve)))
    }
    const tree = render({ client })

    await act(async () => {
      openButton(tree)?.props.onPress()
    })
    await act(async () => {
      resolvers[0]?.(ok({ contentBase64: 'YWJj', bytesRead: 3, eof: false }))
      await Promise.resolve()
    })

    expect(texts(tree).some((text) => text.startsWith('Downloading'))).toBe(true)
  })

  it('does not raise the share sheet once the screen has unmounted mid-download', async () => {
    doubles.shared.length = 0
    let release: ((response: RpcResponse) => void) | undefined
    const client = {
      sendRequest: vi.fn(
        () =>
          new Promise<RpcResponse>((resolve) => {
            release = resolve
          })
      )
    }
    const tree = render({ client })

    await act(async () => {
      openButton(tree)?.props.onPress()
    })
    act(() => tree.unmount())
    await act(async () => {
      release?.(ok({ contentBase64: 'QQ==', bytesRead: 1, eof: true }))
      await Promise.resolve()
    })

    expect(doubles.shared).toEqual([])
  })

  it('does not share an old attempt after the file identity changes', async () => {
    doubles.shared.length = 0
    let release: ((response: RpcResponse) => void) | undefined
    const client = {
      sendRequest: vi.fn(
        () =>
          new Promise<RpcResponse>((resolve) => {
            release = resolve
          })
      )
    }
    const tree = render({ client })

    await act(async () => {
      openButton(tree)?.props.onPress()
    })
    act(() => {
      tree.update(
        createElement(MobileFileMediaHandoff, {
          client,
          connected: true,
          mimeType: 'application/pdf',
          relativePath: 'docs/other.pdf',
          title: 'other.pdf',
          worktreeId: 'wt-1'
        })
      )
    })
    await act(async () => {
      release?.(ok({ contentBase64: 'QQ==', bytesRead: 1, eof: true }))
      await Promise.resolve()
    })

    expect(doubles.shared).toEqual([])
  })

  it('keeps an unmounted attempt from deleting a remounted same-URI cache', async () => {
    doubles.shared.length = 0
    doubles.deleted.length = 0
    doubles.writes.clear()
    const resolvers: ((response: RpcResponse) => void)[] = []
    const client = {
      sendRequest: vi.fn(() => new Promise<RpcResponse>((resolve) => resolvers.push(resolve)))
    }
    const firstTree = render({ client })

    await act(async () => {
      openButton(firstTree)?.props.onPress()
      resolvers[0]?.(ok({ contentBase64: 'T0xE', bytesRead: 3, eof: false }))
      await Promise.resolve()
    })
    const uri = `file:///cache/${mediaHandoffCacheName('wt-1', 'docs/report.pdf')}`
    expect(doubles.writes.get(uri)).toEqual([
      { content: 'T0xE', options: { encoding: 'base64', append: true } }
    ])
    act(() => firstTree.unmount())

    const secondTree = render({ client })
    await act(async () => {
      openButton(secondTree)?.props.onPress()
      await Promise.resolve()
    })
    // The old request resolves after the remount. Its cancelled attempt must not discard the
    // cache now owned by the second component.
    await act(async () => {
      resolvers[1]?.(ok({ contentBase64: 'T0xE', bytesRead: 3, eof: true }))
      await Promise.resolve()
    })
    await act(async () => {
      resolvers[2]?.(ok({ contentBase64: 'TkVX', bytesRead: 3, eof: true }))
      await Promise.resolve()
    })

    expect(doubles.deleted).toEqual([uri])
    expect(doubles.writes.get(uri)).toEqual([
      { content: 'T0xE', options: { encoding: 'base64', append: true } },
      { content: 'TkVX', options: { encoding: 'base64', append: true } }
    ])
    expect(doubles.shared).toHaveLength(1)
  })

  it('shows the refusal copy and keeps the Open button after a failed read', async () => {
    doubles.shared.length = 0
    const client = clientWithResponses([fail('File is binary', 'binary_file')])
    const tree = render({ client })

    await act(async () => {
      openButton(tree)?.props.onPress()
    })

    expect(texts(tree)).toContain('File is binary')
    expect(openButton(tree)).toBeDefined()
    expect(doubles.shared).toEqual([])
  })

  it('waits for the desktop instead of offering an Open it cannot serve', () => {
    const tree = render({ connected: false })

    expect(texts(tree)).toEqual(['Waiting for desktop...'])
    expect(openButton(tree)).toBeUndefined()
  })
})
