import { describe, expect, it } from 'vitest'
import { isRetryableDownloadError } from './transient-download-error'

function nodeError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('isRetryableDownloadError', () => {
  it("retries Chromium's dropped-connection errors", () => {
    expect(isRetryableDownloadError(new Error('net::ERR_CONNECTION_RESET'))).toBe(true)
  })

  // orcad downloads through Node's https, which reports drops by code (#31174).
  it.each([
    ['a response cut mid-body', nodeError('aborted', 'ECONNRESET')],
    ['a reset socket', nodeError('socket hang up', 'ECONNRESET')],
    ['a timed-out connect', nodeError('connect ETIMEDOUT 1.2.3.4:443', 'ETIMEDOUT')],
    ['a DNS hiccup', nodeError('getaddrinfo EAI_AGAIN example.com', 'EAI_AGAIN')],
    ['a DNS outage', nodeError('getaddrinfo ENOTFOUND example.com', 'ENOTFOUND')],
    ['a stream closed early', nodeError('Premature close', 'ERR_STREAM_PREMATURE_CLOSE')]
  ])("retries Node's %s", (_label, error) => {
    expect(isRetryableDownloadError(error)).toBe(true)
  })

  it('does not retry a failure another attempt would repeat', () => {
    expect(isRetryableDownloadError(nodeError('no such file', 'ENOENT'))).toBe(false)
    expect(isRetryableDownloadError(new Error('Model downloads must use HTTPS'))).toBe(false)
    expect(
      isRetryableDownloadError(Object.assign(new Error('HTTP 404'), { httpStatusCode: 404 }))
    ).toBe(false)
  })
})
