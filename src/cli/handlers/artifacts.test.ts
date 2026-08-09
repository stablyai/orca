import { mkdtemp, open, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem } from '../../shared/artifacts'
import { ARTIFACT_HANDLERS } from './artifacts'
import { ARTIFACT_CLI_MAX_RPC_BYTES } from '../../shared/artifacts'

const item: ArtifactListItem = {
  artifact: {
    version: 1,
    slug: 'artifact-1',
    title: null,
    originalFileName: 'report.html',
    sourceContentType: 'text/html',
    renderedContentType: 'text/html',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-09-06T00:00:00.000Z',
    byteSize: 12,
    deletedAt: null
  },
  shareUrl: 'https://share.onorca.dev/a/artifact-1'
}

afterEach(() => vi.restoreAllMocks())

describe('artifact CLI handlers', () => {
  it('reads a relative HTML file and sends sanitized content to the runtime', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-artifact-cli-'))
    await writeFile(join(cwd, 'report.html'), '<h1>Hi</h1>', 'utf8')
    const call = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: { status: 'ok', value: item },
      _meta: { runtimeId: 'runtime-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await ARTIFACT_HANDLERS['artifacts share']!({
      client: { call } as never,
      cwd,
      flags: new Map([['file', 'report.html']]),
      json: false
    })

    expect(call).toHaveBeenCalledWith(
      'artifacts.share',
      expect.objectContaining({
        sourceKey: join(cwd, 'report.html'),
        content: '<h1>Hi</h1>',
        contentType: 'text/html',
        fileName: 'report.html'
      })
    )
    expect(log).toHaveBeenCalledWith(item.shareUrl)
  })

  it('rejects unsupported file extensions before calling the runtime', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-artifact-cli-'))
    await writeFile(join(cwd, 'report.txt'), 'hello', 'utf8')
    const call = vi.fn()

    await expect(
      ARTIFACT_HANDLERS['artifacts share']!({
        client: { call } as never,
        cwd,
        flags: new Map([['file', 'report.txt']]),
        json: false
      })
    ).rejects.toThrow(/HTML or Markdown/)
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects a sparse oversized file before attempting the RPC', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-artifact-cli-'))
    const handle = await open(join(cwd, 'oversized.html'), 'w')
    await handle.truncate(ARTIFACT_CLI_MAX_RPC_BYTES + 1)
    await handle.close()
    const call = vi.fn()

    await expect(
      ARTIFACT_HANDLERS['artifacts share']!({
        client: { call } as never,
        cwd,
        flags: new Map([['file', 'oversized.html']]),
        json: false
      })
    ).rejects.toThrow(/too large/)
    expect(call).not.toHaveBeenCalled()
  })

  it('passes an opaque list cursor through and prints the next cursor', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: {
        status: 'ok',
        value: { artifacts: [item], nextCursor: 'next opaque page' }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await ARTIFACT_HANDLERS['artifacts list']!({
      client: { call } as never,
      cwd: '/repo',
      flags: new Map([['cursor', 'current opaque page']]),
      json: false
    })

    expect(call).toHaveBeenCalledWith('artifacts.list', { cursor: 'current opaque page' })
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('More artifacts: --cursor next opaque page')
    )
  })

  it.each(['environment', 'pairing-code'])(
    'rejects explicit remote selector --%s',
    async (flag) => {
      const call = vi.fn()

      await expect(
        ARTIFACT_HANDLERS['artifacts list']!({
          client: { call } as never,
          cwd: '/repo',
          flags: new Map([[flag, 'remote-host']]),
          json: false
        })
      ).rejects.toThrow(/does not retarget artifact commands/)
      expect(call).not.toHaveBeenCalled()
    }
  )
})
