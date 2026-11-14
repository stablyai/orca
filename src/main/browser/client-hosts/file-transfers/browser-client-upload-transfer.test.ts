import { describe, expect, it } from 'vitest'

import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
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
})
