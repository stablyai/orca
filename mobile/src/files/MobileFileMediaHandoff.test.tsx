import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import { MobileFileMediaHandoff } from './MobileFileMediaHandoff'
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
    expect(mediaHandoffCacheName('docs/my report (1).pdf')).toBe(
      'orca-media-handoff-my_report__1_.pdf'
    )
    expect(mediaHandoffCacheName('videos/clip.MP4')).toBe('orca-media-handoff-clip.MP4')
  })

  it('opens over a stale copy and appends every chunk as base64', () => {
    doubles.preexisting.clear()
    doubles.deleted.length = 0
    doubles.writes.clear()
    doubles.preexisting.add('file:///cache/orca-media-handoff-report.pdf')

    const sink = mediaHandoffSinkFor('docs/report.pdf')
    expect(sink.uri).toBe('file:///cache/orca-media-handoff-report.pdf')
    sink.open()
    expect(doubles.deleted).toEqual(['file:///cache/orca-media-handoff-report.pdf'])
    sink.appendBase64('AAA=')
    sink.appendBase64('QQ==')
    expect(doubles.writes.get('file:///cache/orca-media-handoff-report.pdf')).toEqual([
      { content: 'AAA=', options: { encoding: 'base64', append: true } },
      { content: 'QQ==', options: { encoding: 'base64', append: true } }
    ])
    sink.discard()
    expect(doubles.deleted).toHaveLength(2)
  })
})

describe('a PDF the phone hands to the OS', () => {
  it('downloads it chunk-by-chunk and hands the cached file to the share sheet', async () => {
    doubles.shared.length = 0
    doubles.shareRejects = false
    const client = clientWithResponses(
      [
        { contentBase64: 'AAA=', bytesRead: 524288, eof: false },
        { contentBase64: 'QQ==', bytesRead: 16, eof: true }
      ].map(ok)
    )
    const tree = render({ client })

    await act(async () => {
      openButton(tree)?.props.onPress()
    })

    expect(client.sendRequest).toHaveBeenCalledWith('files.readChunk', {
      worktree: 'id:wt-1',
      relativePath: 'docs/report.pdf',
      offset: 0,
      length: 524288
    })
    expect(doubles.shared).toEqual([
      {
        uri: 'file:///cache/orca-media-handoff-report.pdf',
        options: { mimeType: 'application/pdf', dialogTitle: 'Open report.pdf' }
      }
    ])
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
