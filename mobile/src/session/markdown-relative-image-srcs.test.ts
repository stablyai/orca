import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  collectMarkdownImageSrcs,
  readMarkdownImageSources,
  resolveMarkdownRelativeImagePath
} from './markdown-relative-image-srcs'

const META = { runtimeId: 'runtime-1' }

describe('collectMarkdownImageSrcs', () => {
  it('collects the distinct relative srcs in first-appearance order', () => {
    const content = [
      '# Title',
      '',
      '![One](docs/a.png)',
      '![Two](img/b.png)',
      '![One again](docs/a.png)',
      '',
      '![Badge](https://cdn.example.com/badge.svg)',
      '![Proto](//cdn.example.com/x.png)',
      '![Data](data:image/png;base64,QUJD)',
      '![Anchor](#section)',
      ''
    ].join('\n')
    expect(collectMarkdownImageSrcs(content)).toEqual(['docs/a.png', 'img/b.png'])
  })

  it('uses the same decoded source as the editor image attributes', () => {
    expect(collectMarkdownImageSrcs('![Shot](a&amp;b.png)')).toEqual(['a&b.png'])
  })

  it('reads no image across a line break the editor would not render either', () => {
    expect(collectMarkdownImageSrcs('![broken\nalt](a.png)')).toEqual([])
  })
})

describe('resolveMarkdownRelativeImagePath', () => {
  it('resolves against the markdown document directory', () => {
    expect(resolveMarkdownRelativeImagePath('a.png', 'README.md')).toBe('a.png')
    expect(resolveMarkdownRelativeImagePath('a.png', 'docs/guide/intro.md')).toBe(
      'docs/guide/a.png'
    )
    expect(resolveMarkdownRelativeImagePath('./up.png', 'docs/guide/intro.md')).toBe(
      'docs/guide/up.png'
    )
    expect(resolveMarkdownRelativeImagePath('../shared/logo.svg', 'docs/guide/intro.md')).toBe(
      'docs/shared/logo.svg'
    )
  })

  it('treats a rooted src as worktree-rooted', () => {
    expect(resolveMarkdownRelativeImagePath('/assets/hero.png', 'docs/guide/intro.md')).toBe(
      'assets/hero.png'
    )
  })

  it('rejects a src that climbs out of the worktree', () => {
    expect(resolveMarkdownRelativeImagePath('../../escape.png', 'docs/intro.md')).toBeNull()
  })

  it('leaves decoded separators for the execution host path guard', () => {
    expect(resolveMarkdownRelativeImagePath('images%2Fscreenshot.png', 'docs/intro.md')).toBe(
      'docs/images/screenshot.png'
    )
    expect(resolveMarkdownRelativeImagePath('..%2F..%2Foutside.png', 'docs/intro.md')).toBe(
      'docs/../../outside.png'
    )
    expect(resolveMarkdownRelativeImagePath('..%5C..%5Coutside.png', 'docs/intro.md')).toBe(
      'docs/..\\..\\outside.png'
    )
    expect(
      resolveMarkdownRelativeImagePath('%2e%2e/%2e%2e/outside.png', 'docs/intro.md')
    ).toBeNull()
  })

  it('decodes escapes and drops a query or fragment before resolving', () => {
    expect(resolveMarkdownRelativeImagePath('my%20file.png', 'docs/intro.md')).toBe(
      'docs/my file.png'
    )
    expect(resolveMarkdownRelativeImagePath('shot.png?raw=1', 'docs/intro.md')).toBe(
      'docs/shot.png'
    )
    expect(resolveMarkdownRelativeImagePath('shot.png#detail', 'docs/intro.md')).toBe(
      'docs/shot.png'
    )
  })
})

function clientAnswering(replies: Record<string, RpcResponse | (() => RpcResponse)>) {
  return {
    sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
      const reply = replies[method]
      return typeof reply === 'function' ? reply() : (reply ?? refused(method))
    })
  }
}

function refused(method: string): RpcResponse {
  return {
    id: 'frame-1',
    ok: false,
    error: { code: 'runtime_error', message: method },
    _meta: META
  }
}

function imageReply(extra: Record<string, unknown> = {}): RpcResponse {
  return {
    id: 'frame-1',
    ok: true,
    result: { content: 'QUJD', isImage: true, mimeType: 'image/png', ...extra },
    _meta: META
  }
}

describe('readMarkdownImageSources', () => {
  it('answers the data URLs keyed by the authored src', async () => {
    const sources = await readMarkdownImageSources(
      clientAnswering({ 'files.readPreview': imageReply() }),
      'wt-1',
      'docs/intro.md',
      'Intro\n\n![Shot](./shot.png)\n'
    )
    expect(sources).toEqual({ './shot.png': 'data:image/png;base64,QUJD' })
  })

  it('leaves an unreadable or non-image file as the editor’s existing broken image', async () => {
    const refusedSources = await readMarkdownImageSources(
      clientAnswering({}),
      'wt-1',
      'docs/intro.md',
      '![Missing](gone.png)\n'
    )
    expect(refusedSources).toEqual({})

    const notImageSources = await readMarkdownImageSources(
      clientAnswering({
        'files.readPreview': imageReply({ isImage: false, mimeType: 'application/pdf' })
      }),
      'wt-1',
      'docs/intro.md',
      '![Pdf](file.pdf)\n'
    )
    expect(notImageSources).toEqual({})
  })

  it('skips a src the file tab itself would not classify as an image', async () => {
    const client = clientAnswering({ 'files.readPreview': imageReply() })
    const sources = await readMarkdownImageSources(
      client,
      'wt-1',
      'docs/intro.md',
      '![Docx](asset.docx)\n'
    )
    expect(sources).toEqual({})
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
})
