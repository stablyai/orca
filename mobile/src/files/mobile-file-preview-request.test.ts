import { describe, expect, it, vi } from 'vitest'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import {
  createMobileFilePreviewRequest,
  formatPreviewByteLength,
  loadMobileFilePreview,
  normalizeMobileFilePreviewResponse,
  saveMobileTerminalArtifactPreview
} from './mobile-file-preview-request'

function ok(result: unknown): RpcSuccess {
  return { id: '1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function fail(message: string, code = 'error'): RpcFailure {
  return { id: '1', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

function clientWith(response: RpcResponse) {
  return {
    sendRequest: vi.fn(async () => response)
  }
}

function clientWithResponses(responses: RpcResponse[]) {
  return {
    sendRequest: vi.fn(async () => responses.shift()!)
  }
}

function pngBase64(width = 1, height = 1): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

describe('mobile-file-preview-request', () => {
  it('selects readPreview for raster images and read for text-like files', () => {
    expect(createMobileFilePreviewRequest('wt-1', 'assets/logo.png')).toEqual({
      method: 'files.readPreview',
      params: { worktree: 'id:wt-1', relativePath: 'assets/logo.png' }
    })
    expect(createMobileFilePreviewRequest('wt-1', 'docs/readme.md')).toEqual({
      method: 'files.read',
      params: { worktree: 'id:wt-1', relativePath: 'docs/readme.md' }
    })
    expect(createMobileFilePreviewRequest('wt-1', 'public/index.html')).toEqual({
      method: 'files.read',
      params: { worktree: 'id:wt-1', relativePath: 'public/index.html' }
    })
  })

  it('loads images through readPreview and never calls files.open', async () => {
    const content = pngBase64()
    const client = clientWith(ok({ content, isBinary: true, isImage: true, mimeType: 'image/png' }))

    await expect(loadMobileFilePreview(client, 'wt-1', 'assets/logo.png')).resolves.toEqual({
      status: 'ready',
      kind: 'image',
      dataUri: `data:image/png;base64,${content}`
    })
    expect(client.sendRequest).toHaveBeenCalledWith('files.readPreview', {
      worktree: 'id:wt-1',
      relativePath: 'assets/logo.png'
    })
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.open', expect.anything())
  })

  it('loads terminal artifacts through grant-scoped artifact RPCs', async () => {
    const client = clientWith(ok({ content: '{"ok":true}', truncated: false, byteLength: 11 }))

    await expect(
      loadMobileFilePreview(client, {
        source: 'terminalArtifact',
        worktreeId: 'wt-1',
        absolutePath: '/tmp/result.json',
        grantId: 'grant-1'
      })
    ).resolves.toMatchObject({ status: 'ready', kind: 'text', content: '{"ok":true}' })

    expect(client.sendRequest).toHaveBeenCalledWith('files.readTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1'
    })
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.read', expect.anything())
  })

  it('refreshes an expired terminal artifact grant and retries the read once', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_expired'),
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-2'
        }
      }),
      ok({ content: '{"ok":true}', truncated: false, byteLength: 11 })
    ])
    const onTerminalArtifactSourceRefreshed = vi.fn()

    await expect(
      loadMobileFilePreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1',
          pathText: 'result.json',
          cwd: '/tmp/run'
        },
        undefined,
        { onTerminalArtifactSourceRefreshed }
      )
    ).resolves.toMatchObject({ status: 'ready', kind: 'text', content: '{"ok":true}' })

    expect(client.sendRequest).toHaveBeenNthCalledWith(1, 'files.readTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'files.resolveTerminalPath', {
      worktree: 'id:wt-1',
      pathText: 'result.json',
      cwd: '/tmp/run',
      terminal: 'term-1'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(3, 'files.readTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2'
    })
    expect(onTerminalArtifactSourceRefreshed).toHaveBeenCalledWith({
      source: 'terminalArtifact',
      worktreeId: 'wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      terminalHandle: 'term-1',
      pathText: 'result.json',
      cwd: '/tmp/run'
    })
  })

  it('refreshes a stale terminal artifact grant and retries the read once', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_stale'),
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-2'
        }
      }),
      ok({ content: '{"ok":true}', truncated: false, byteLength: 11 })
    ])

    await expect(
      loadMobileFilePreview(client, {
        source: 'terminalArtifact',
        worktreeId: 'wt-1',
        absolutePath: '/tmp/result.json',
        grantId: 'grant-1',
        terminalHandle: 'term-1'
      })
    ).resolves.toMatchObject({ status: 'ready', kind: 'text', content: '{"ok":true}' })

    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'files.resolveTerminalPath', {
      worktree: 'id:wt-1',
      pathText: '/tmp/result.json',
      terminal: 'term-1'
    })
  })

  it.each([
    ['terminal_file_grant_expired'],
    ['terminal_file_grant_mismatch'],
    ['terminal_file_grant_stale']
  ])(
    'does not refresh a %s terminal artifact grant when disabled for a dirty editor',
    async (error) => {
      const client = clientWithResponses([fail(error)])

      await expect(
        loadMobileFilePreview(
          client,
          {
            source: 'terminalArtifact',
            worktreeId: 'wt-1',
            absolutePath: '/tmp/result.json',
            grantId: 'grant-1'
          },
          undefined,
          { refreshGrant: false }
        )
      ).resolves.toEqual({
        status: 'error',
        message: 'Reload preview before saving',
        reconnect: false
      })

      expect(client.sendRequest).toHaveBeenCalledTimes(1)
      expect(client.sendRequest).toHaveBeenCalledWith('files.readTerminalArtifact', {
        worktree: 'id:wt-1',
        absolutePath: '/tmp/result.json',
        grantId: 'grant-1'
      })
    }
  )

  it('saves terminal artifacts through the same exact-path grant', async () => {
    const client = clientWith(ok({ ok: true }))

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1',
          pathText: 'result.json',
          cwd: '/tmp/run'
        },
        '{"ok":false}'
      )
    ).resolves.toEqual({ status: 'saved' })

    expect(client.sendRequest).toHaveBeenCalledWith('files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1',
      content: '{"ok":false}'
    })
  })

  it('does not refresh and retry a failed terminal artifact save without a base content check', async () => {
    const client = clientWithResponses([fail('terminal_file_grant_mismatch')])

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1',
          pathText: 'result.json',
          cwd: '/tmp/run'
        },
        '{"ok":false}'
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'Reload preview before saving',
      reconnect: false
    })

    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(client.sendRequest).toHaveBeenCalledWith('files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1',
      content: '{"ok":false}'
    })
  })

  it('refreshes an expired terminal artifact grant and retries save when the file still matches the base content', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_expired'),
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-2'
        }
      }),
      ok({ content: '{"ok":true}', truncated: false, byteLength: 11 }),
      ok({ ok: true })
    ])
    const onTerminalArtifactSourceRefreshed = vi.fn()

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1',
          pathText: 'result.json',
          cwd: '/tmp/run'
        },
        '{"ok":false}',
        { baseContent: '{"ok":true}', onTerminalArtifactSourceRefreshed }
      )
    ).resolves.toEqual({ status: 'saved' })

    expect(client.sendRequest).toHaveBeenNthCalledWith(1, 'files.readTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'files.resolveTerminalPath', {
      worktree: 'id:wt-1',
      pathText: 'result.json',
      cwd: '/tmp/run',
      terminal: 'term-1'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(3, 'files.readTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(4, 'files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      content: '{"ok":false}'
    })
    expect(onTerminalArtifactSourceRefreshed).toHaveBeenCalledWith({
      source: 'terminalArtifact',
      worktreeId: 'wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      terminalHandle: 'term-1',
      pathText: 'result.json',
      cwd: '/tmp/run'
    })
  })

  it('keeps the dirty draft when a refreshed terminal artifact save finds changed remote content', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_stale'),
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-2'
        }
      }),
      ok({ content: '{"ok":"changed"}', truncated: false, byteLength: 16 })
    ])
    const onTerminalArtifactSourceRefreshed = vi.fn()

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1'
        },
        '{"ok":false}',
        { baseContent: '{"ok":true}', onTerminalArtifactSourceRefreshed }
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'File changed on desktop. Reload preview before saving',
      reconnect: false
    })

    expect(client.sendRequest).toHaveBeenCalledTimes(3)
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      content: '{"ok":false}'
    })
    expect(onTerminalArtifactSourceRefreshed).not.toHaveBeenCalled()
  })

  it('reports a failed refreshed artifact read instead of treating it as changed desktop content', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_stale'),
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-2'
        }
      }),
      fail('provider unavailable')
    ])

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1'
        },
        '{"ok":false}',
        { baseContent: '{"ok":true}' }
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'Unable to reach the desktop filesystem',
      reconnect: true
    })

    expect(client.sendRequest).toHaveBeenCalledTimes(3)
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      content: '{"ok":false}'
    })
  })

  it('reports a malformed refreshed artifact read instead of treating it as changed desktop content', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_stale'),
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-2'
        }
      }),
      ok({ truncated: false, byteLength: 11 })
    ])

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/result.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1'
        },
        '{"ok":false}',
        { baseContent: '{"ok":true}' }
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'Unable to load preview',
      reconnect: false
    })

    expect(client.sendRequest).toHaveBeenCalledTimes(3)
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.writeTerminalArtifact', {
      worktree: 'id:wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-2',
      content: '{"ok":false}'
    })
  })

  it('does not retry a dirty save when grant refresh resolves to a different artifact', async () => {
    const client = clientWithResponses([
      fail('terminal_file_grant_expired'),
      ok({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/b.json',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          absolutePath: '/tmp/b.json',
          grantId: 'grant-2'
        }
      })
    ])
    const onTerminalArtifactSourceRefreshed = vi.fn()

    await expect(
      saveMobileTerminalArtifactPreview(
        client,
        {
          source: 'terminalArtifact',
          worktreeId: 'wt-1',
          absolutePath: '/tmp/a.json',
          grantId: 'grant-1',
          terminalHandle: 'term-1',
          pathText: '/tmp/link.json'
        },
        '{"ok":false}',
        { baseContent: '{"ok":true}', onTerminalArtifactSourceRefreshed }
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'Reload preview before saving',
      reconnect: false
    })

    expect(client.sendRequest).toHaveBeenCalledTimes(2)
    expect(onTerminalArtifactSourceRefreshed).not.toHaveBeenCalled()
  })

  it.each([
    ['missing isBinary', { content: pngBase64(), isImage: true, mimeType: 'image/png' }],
    ['missing isImage', { content: pngBase64(), isBinary: true, mimeType: 'image/png' }],
    ['missing mimeType', { content: pngBase64(), isBinary: true, isImage: true }],
    ['empty content', { content: '', isBinary: true, isImage: true, mimeType: 'image/png' }]
  ])('rejects invalid image preview results: %s', (_label, result) => {
    expect(normalizeMobileFilePreviewResponse('assets/logo.png', ok(result))).toEqual({
      status: 'error',
      message: 'Binary preview unavailable',
      reconnect: false
    })
  })

  it('rejects an oversized raster response before React Native receives a data URI', () => {
    expect(
      normalizeMobileFilePreviewResponse(
        'assets/logo.png',
        ok({
          content: pngBase64(32_769, 1),
          isBinary: true,
          isImage: true,
          mimeType: 'image/png'
        })
      )
    ).toEqual({
      status: 'error',
      message: 'Binary preview unavailable',
      reconnect: false
    })
  })

  it('normalizes markdown, html, text, empty, and truncated reads', () => {
    expect(
      normalizeMobileFilePreviewResponse(
        'README.md',
        ok({ content: '# Hi', truncated: false, byteLength: 4 })
      )
    ).toEqual({
      status: 'ready',
      kind: 'markdown',
      content: '# Hi',
      truncated: false,
      byteLength: 4
    })
    expect(
      normalizeMobileFilePreviewResponse(
        'index.html',
        ok({ content: '<h1>Hi</h1>', truncated: false, byteLength: 11 })
      )
    ).toMatchObject({ status: 'ready', kind: 'html' })
    expect(
      normalizeMobileFilePreviewResponse(
        'src/app.ts',
        ok({ content: 'const a = 1', truncated: true, byteLength: 700_000 })
      )
    ).toEqual({
      status: 'ready',
      kind: 'text',
      content: 'const a = 1',
      truncated: true,
      byteLength: 700_000
    })
    expect(
      normalizeMobileFilePreviewResponse(
        'empty.txt',
        ok({ content: '', truncated: false, byteLength: 0 })
      )
    ).toEqual({ status: 'empty', kind: 'text' })
  })

  it.each([
    ['binary_file', 'Binary preview unavailable', false],
    ['file_too_large', 'File too large for mobile preview', false],
    ['ENOENT: no such file or directory', 'File not found', false],
    [
      'Remote connection dropped. Click Reconnect on the SSH target before retrying.',
      'Unable to reach the desktop filesystem',
      true
    ],
    ['provider unavailable', 'Unable to reach the desktop filesystem', true],
    ['terminal_file_grant_stale', 'Reload preview before saving', false],
    ['permission denied', 'Unable to load preview', false]
  ])('maps preview failure %s', (message, expected, reconnect) => {
    expect(normalizeMobileFilePreviewResponse('src/app.ts', fail(message))).toEqual({
      status: 'error',
      message: expected,
      reconnect
    })
  })

  it('formats truncation byte counts for the UI note', () => {
    expect(formatPreviewByteLength(512)).toBe('512 B')
    expect(formatPreviewByteLength(4096)).toBe('4 KB')
    expect(formatPreviewByteLength(1_572_864)).toBe('1.5 MB')
  })
})
