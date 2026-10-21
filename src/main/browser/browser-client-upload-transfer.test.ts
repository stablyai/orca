import { describe, expect, it } from 'vitest'

import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import {
  BROWSER_CLIENT_FILE_CHANNEL_READ_METHOD,
  fetchBrowserClientUploadFiles,
  readBrowserClientUploadPaths
} from './browser-client-upload-transfer'

const event = {
  authorityRuntimeId: 'runtime-1',
  authorityEpoch: 'epoch-1',
  browserHostClientId: 'host-1',
  browserHostGeneration: 2,
  browserPageId: 'page-1',
  pageHostGeneration: 3
} as BrowserClientHostCommandEvent

describe('fetchBrowserClientUploadFiles', () => {
  it('reassembles a multi-chunk remote file and stamps the page authority on every read', async () => {
    const requests: { method: string; params: Record<string, unknown> }[] = []
    const chunks = ['abc', 'de']
    const files = await fetchBrowserClientUploadFiles({
      request: async (method, params) => {
        requests.push({ method, params: params as Record<string, unknown> })
        const chunk = chunks.shift() ?? ''
        return {
          contentBase64: Buffer.from(chunk).toString('base64'),
          bytesRead: chunk.length,
          totalBytes: 5,
          eof: chunks.length === 0
        }
      },
      event,
      remotePaths: ['docs/a.txt']
    })

    expect(files).toEqual([{ remotePath: 'docs/a.txt', contents: Buffer.from('abcde') }])
    expect(requests).toHaveLength(2)
    expect(requests[0].method).toBe(BROWSER_CLIENT_FILE_CHANNEL_READ_METHOD)
    expect(requests[0].params).toMatchObject({
      fileChannelProtocolVersion: 1,
      browserPageId: 'page-1',
      pageHostGeneration: 3,
      workspaceRelativePath: 'docs/a.txt',
      offset: 0
    })
    expect(requests[1].params).toMatchObject({ offset: 3 })
  })

  it('stops instead of looping forever on a host that never reports eof', async () => {
    await expect(
      fetchBrowserClientUploadFiles({
        request: async () => ({ contentBase64: '', bytesRead: 0, totalBytes: 0, eof: false }),
        event,
        remotePaths: ['a.txt']
      })
    ).rejects.toThrow('browser_client_upload_transfer_stalled')
  })

  it('rejects a chunk whose declared length does not match its bytes', async () => {
    await expect(
      fetchBrowserClientUploadFiles({
        request: async () => ({
          contentBase64: Buffer.from('abc').toString('base64'),
          bytesRead: 99,
          totalBytes: 99,
          eof: true
        }),
        event,
        remotePaths: ['a.txt']
      })
    ).rejects.toThrow('browser_client_upload_chunk_invalid')
  })

  it('rejects a request naming more files than the command budget allows', async () => {
    await expect(
      fetchBrowserClientUploadFiles({
        request: async () => ({ contentBase64: '', bytesRead: 0, totalBytes: 0, eof: true }),
        event,
        remotePaths: Array.from({ length: 17 }, (_unused, index) => `${index}.txt`)
      })
    ).rejects.toThrow('browser_client_upload_file_count_exceeded')
  })
})

describe('readBrowserClientUploadPaths', () => {
  it('accepts a list of non-empty path strings', () => {
    expect(readBrowserClientUploadPaths({ files: ['a.txt', 'b/c.txt'] })).toEqual([
      'a.txt',
      'b/c.txt'
    ])
  })

  it('rejects a missing, non-array, or non-string files payload', () => {
    expect(() => readBrowserClientUploadPaths({})).toThrow('browser_client_upload_files_required')
    expect(() => readBrowserClientUploadPaths({ files: 'a.txt' })).toThrow(
      'browser_client_upload_files_required'
    )
    expect(() => readBrowserClientUploadPaths({ files: [''] })).toThrow(
      'browser_client_upload_files_required'
    )
  })
})
