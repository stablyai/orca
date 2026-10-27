import { describe, expect, it } from 'vitest'

import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { fetchBrowserClientUploadFiles } from './browser-client-upload-transfer'

const event = {
  authorityRuntimeId: 'runtime-1',
  authorityEpoch: 'epoch-1',
  browserHostClientId: 'host-1',
  browserHostGeneration: 2,
  browserPageId: 'page-1',
  pageHostGeneration: 3
} as BrowserClientHostCommandEvent

describe('fetchBrowserClientUploadFiles', () => {
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
