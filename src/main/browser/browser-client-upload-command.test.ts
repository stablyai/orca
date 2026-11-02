import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
    // A later page release needs the retained directory record to retry cleanup.
    expect(staging.activeStagingCount()).toBe(1)
  })
})
