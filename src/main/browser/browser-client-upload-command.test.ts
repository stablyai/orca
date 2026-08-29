import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import { executeBrowserClientUploadCommand } from './browser-client-upload-command'
import { BrowserClientUploadStaging } from './browser-client-upload-staging'

let stagingRoot = ''

beforeEach(async () => {
  stagingRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-upload-command-')))
})

afterEach(async () => {
  await rm(stagingRoot, { recursive: true, force: true })
})

function uploadEvent(files: unknown): BrowserClientHostCommandEvent {
  return {
    type: 'command',
    pageCommandProtocolVersion: 1,
    authorityRuntimeId: 'runtime-1',
    authorityEpoch: 'epoch-1',
    browserHostClientId: 'host-1',
    browserHostGeneration: 2,
    browserPageId: 'page-1',
    pageHostGeneration: 3,
    commandSequence: 1,
    commandId: 'command-1',
    command: { type: 'automation', method: 'browser.upload', params: { element: '#f', files } }
  } as BrowserClientHostCommandEvent
}

function transportReturning(
  responses: Map<string, { contentBase64: string; bytesRead: number; eof: boolean }[]>
): { transport: BrowserClientFileChannelTransport; calls: unknown[] } {
  const calls: unknown[] = []
  const transport = new BrowserClientFileChannelTransport()
  transport.bind({
    fileChannelNegotiated: true,
    fileChannelAvailability: 'negotiated' as const,
    sendFileChannelRequest: async (_method, params) => {
      calls.push(params)
      const requested = (params as { workspaceRelativePath: string }).workspaceRelativePath
      const queue = responses.get(requested)
      if (!queue?.length) {
        return { ok: false, error: { code: 'not_found', message: 'missing' }, _meta: {} } as never
      }
      const next = queue.shift()
      return {
        ok: true,
        result: { ...next, totalBytes: next?.bytesRead ?? 0 },
        _meta: {}
      } as never
    }
  })
  return { transport, calls }
}

describe('executeBrowserClientUploadCommand', () => {
  it('rewrites remote paths to staged copies that outlive the command until the page is released', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)
    const { transport, calls } = transportReturning(
      new Map([
        [
          'docs/report.pdf',
          [{ contentBase64: Buffer.from('hello').toString('base64'), bytesRead: 5, eof: true }]
        ]
      ])
    )
    const run = vi.fn().mockResolvedValue({ uploaded: true })

    const result = await executeBrowserClientUploadCommand({
      event: uploadEvent(['docs/report.pdf']),
      params: { element: '#f', files: ['docs/report.pdf'] },
      fileChannel: transport,
      staging,
      run
    })

    expect(result).toEqual({ uploaded: true })
    const rewritten = run.mock.calls[0][0] as { files: string[] }
    expect(rewritten.files).toHaveLength(1)
    expect(path.basename(rewritten.files[0])).toBe('report.pdf')
    expect(rewritten.files[0]).not.toBe('docs/report.pdf')
    expect(calls).toHaveLength(1)
    // Why: Chromium opens the recorded path at submit time, long after browser.upload resolved.
    expect(await readFile(rewritten.files[0], 'utf8')).toBe('hello')
    expect(staging.activeStagingCount()).toBe(1)

    expect(await staging.releasePage('page-1')).toBe(1)
    expect(await readdir(stagingRoot)).toHaveLength(0)
  })

  it('fails closed and stages nothing when the file channel was not negotiated', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)
    const transport = new BrowserClientFileChannelTransport()
    const run = vi.fn()

    await expect(
      executeBrowserClientUploadCommand({
        event: uploadEvent(['/etc/passwd']),
        params: { element: '#f', files: ['/etc/passwd'] },
        fileChannel: transport,
        staging,
        run
      })
    ).rejects.toThrow('browser_client_file_channel_unsupported')
    expect(run).not.toHaveBeenCalled()
    // Why: staging sweeps the root on construction, so an untouched root is one that never existed.
    expect(staging.activeStagingCount()).toBe(0)
    expect(existsSync(stagingRoot)).toBe(false)
  })

  it('removes staged files when the upload itself fails', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)
    const { transport } = transportReturning(
      new Map([['a.txt', [{ contentBase64: '', bytesRead: 0, eof: true }]]])
    )

    await expect(
      executeBrowserClientUploadCommand({
        event: uploadEvent(['a.txt']),
        params: { element: '#f', files: ['a.txt'] },
        fileChannel: transport,
        staging,
        run: async () => {
          throw new Error('element not found')
        }
      })
    ).rejects.toThrow('element not found')
    expect(staging.activeStagingCount()).toBe(0)
    expect(await readdir(stagingRoot)).toHaveLength(0)
  })

  it('reports the upload failure, not the cleanup failure, when both fail', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot, {
      mkdir: async () => {},
      writeFile: async () => {},
      removeDirectorySync: () => {},
      removeDirectory: async () => {
        throw new Error('EBUSY: resource busy or locked')
      }
    })
    const { transport } = transportReturning(
      new Map([['a.txt', [{ contentBase64: '', bytesRead: 0, eof: true }]]])
    )

    await expect(
      executeBrowserClientUploadCommand({
        event: uploadEvent(['a.txt']),
        params: { element: '#f', files: ['a.txt'] },
        fileChannel: transport,
        staging,
        run: async () => {
          throw new Error('element not found')
        }
      })
    ).rejects.toThrow('element not found')
    // Why: the retained record is the only handle a later page release has on the directory.
    expect(staging.activeStagingCount()).toBe(1)
  })

  it('rejects a params payload whose files are not remote path strings', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)
    const { transport } = transportReturning(new Map())

    await expect(
      executeBrowserClientUploadCommand({
        event: uploadEvent([{ path: 'a.txt' }]),
        params: { element: '#f', files: [{ path: 'a.txt' }] },
        fileChannel: transport,
        staging,
        run: async () => undefined
      })
    ).rejects.toThrow('browser_client_upload_files_required')
  })
})
