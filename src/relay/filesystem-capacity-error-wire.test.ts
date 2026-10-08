import { expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, RelayErrorCode } from './protocol'
import { GitGrepRecordCapacityError } from '../shared/git-grep-record-limit'
import { MarkdownDocumentListingCapacityError } from '../shared/markdown-document-listing-limits'
import { DirectoryListingCapacityError } from '../shared/directory-listing-budget'

it.each([
  [new GitGrepRecordCapacityError(), RelayErrorCode.GitGrepRecordCapacity],
  [new MarkdownDocumentListingCapacityError(), RelayErrorCode.MarkdownListingCapacity],
  [new DirectoryListingCapacityError(), RelayErrorCode.DirectoryListingCapacity]
])(
  'preserves typed filesystem capacity errors across the existing JSON-RPC envelope',
  async (failure, code) => {
    vi.useFakeTimers()
    const frames: Buffer[] = []
    const dispatcher = new RelayDispatcher((frame) => {
      frames.push(frame)
      return true
    })
    try {
      dispatcher.onRequest('fs.fixture', async () => {
        throw failure
      })
      dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 1, method: 'fs.fixture' }, 1, 0))
      await vi.advanceTimersByTimeAsync(0)
      expect(frames).toHaveLength(1)
      const frame = frames[0]
      const response = JSON.parse(frame.subarray(13, 13 + frame.readUInt32BE(9)).toString())
      expect(response.error.code).toBe(code)
      expect(response.error.message).toBe(failure.message)
    } finally {
      dispatcher.dispose()
      vi.useRealTimers()
    }
  }
)
