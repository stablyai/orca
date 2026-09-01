import { mkdtemp, open, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem } from '../../shared/artifacts'
import { ARTIFACT_HANDLERS } from './artifacts'
import { ARTIFACT_CLI_MAX_RPC_BYTES } from '../../shared/artifacts'
import {
  ARTIFACT_SHARING_DISABLED_CODE,
  ARTIFACT_SHARING_DISABLED_MESSAGE,
  ARTIFACT_SHARING_DISABLED_NEXT_STEPS
} from '../../shared/artifact-sharing-gate'
import { RuntimeRpcFailureError } from '../runtime-client'
import { reportCliError } from '../format'

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
    const call = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: { settings: { artifactSharingEnabled: true } },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      ARTIFACT_HANDLERS['artifacts share']!({
        client: { call } as never,
        cwd,
        flags: new Map([['file', 'oversized.html']]),
        json: false
      })
    ).rejects.toThrow(/too large/)
    // The capability preflight is the only permitted call; the oversized body never ships.
    expect(call).not.toHaveBeenCalledWith('artifacts.share', expect.anything())
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

  it.each(['artifacts share', 'artifacts update'])(
    'denies `%s` from the capability preflight without reading or shipping the file',
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), 'orca-artifact-cli-'))
      await writeFile(join(cwd, 'report.html'), '<h1>Hi</h1>', 'utf8')
      const call = vi.fn().mockResolvedValue({
        id: 'request-1',
        ok: true,
        result: { settings: { artifactSharingEnabled: false } },
        _meta: { runtimeId: 'runtime-1' }
      })

      await expect(
        ARTIFACT_HANDLERS[command]!({
          client: { call } as never,
          cwd,
          flags: new Map([['file', 'report.html']]),
          json: false
        })
      ).rejects.toMatchObject({
        code: ARTIFACT_SHARING_DISABLED_CODE,
        data: { nextSteps: [...ARTIFACT_SHARING_DISABLED_NEXT_STEPS] }
      })

      expect(call).toHaveBeenCalledExactlyOnceWith('settings.get', { includeAgentCatalog: false })
    }
  )

  it.each([
    ['omits the capability field', {}],
    ['cannot answer the preflight', null]
  ])('still attempts the publish RPC when the host %s', async (_label, settings) => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-artifact-cli-'))
    await writeFile(join(cwd, 'report.html'), '<h1>Hi</h1>', 'utf8')
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'settings.get') {
        if (!settings) {
          return Promise.reject(new Error('unsupported_method'))
        }
        return Promise.resolve({
          id: 'request-1',
          ok: true,
          result: { settings },
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      return Promise.resolve({
        id: 'request-2',
        ok: true,
        result: { status: 'ok', value: item },
        _meta: { runtimeId: 'runtime-1' }
      })
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await ARTIFACT_HANDLERS['artifacts share']!({
      client: { call } as never,
      cwd,
      flags: new Map([['file', 'report.html']]),
      json: false
    })

    expect(call).toHaveBeenCalledWith(
      'artifacts.share',
      expect.objectContaining({ content: '<h1>Hi</h1>' })
    )
  })

  it.each(['artifacts share', 'artifacts update'])(
    'surfaces the capability denial from `%s` with actionable next steps',
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), 'orca-artifact-cli-'))
      await writeFile(join(cwd, 'report.html'), '<h1>Hi</h1>', 'utf8')
      const call = vi.fn().mockRejectedValue(
        new RuntimeRpcFailureError({
          id: 'request-1',
          ok: false,
          error: {
            code: ARTIFACT_SHARING_DISABLED_CODE,
            message: ARTIFACT_SHARING_DISABLED_MESSAGE,
            data: { nextSteps: [...ARTIFACT_SHARING_DISABLED_NEXT_STEPS] }
          },
          _meta: { runtimeId: 'runtime-1' }
        })
      )
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      await expect(
        ARTIFACT_HANDLERS[command]!({
          client: { call } as never,
          cwd,
          flags: new Map([['file', 'report.html']]),
          json: false
        })
      ).rejects.toMatchObject({ code: ARTIFACT_SHARING_DISABLED_CODE })

      // The CLI entry point reports the thrown error; assert the rendered text is actionable.
      reportCliError(
        await ARTIFACT_HANDLERS[command]!({
          client: { call } as never,
          cwd,
          flags: new Map([['file', 'report.html']]),
          json: false
        }).catch((error: unknown) => error),
        false,
        { commandPath: command.split(' ') }
      )
      const rendered = String(errorLog.mock.calls.at(-1)?.[0])
      expect(rendered).toContain(ARTIFACT_SHARING_DISABLED_MESSAGE)
      expect(rendered).toContain('Settings → Artifacts')
    }
  )

  it('reports the denial with a stable code in --json mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-artifact-cli-'))
    await writeFile(join(cwd, 'report.html'), '<h1>Hi</h1>', 'utf8')
    const call = vi.fn().mockRejectedValue(
      new RuntimeRpcFailureError({
        id: 'request-1',
        ok: false,
        error: {
          code: ARTIFACT_SHARING_DISABLED_CODE,
          message: ARTIFACT_SHARING_DISABLED_MESSAGE,
          data: { nextSteps: [...ARTIFACT_SHARING_DISABLED_NEXT_STEPS] }
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const error = await ARTIFACT_HANDLERS['artifacts share']!({
      client: { call } as never,
      cwd,
      flags: new Map([['file', 'report.html']]),
      json: true
    }).catch((thrown: unknown) => thrown)
    reportCliError(error, true)

    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).error).toMatchObject({
      code: ARTIFACT_SHARING_DISABLED_CODE
    })
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
