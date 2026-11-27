import { expect, it } from 'vitest'
import { isRetryableDownloadError } from './transient-download-error'

it('retries Node fetch connect and mid-body failures through their transport cause', () => {
  const transport = (message: string, code: string): Error =>
    Object.assign(new Error(message), { code })
  expect(
    isRetryableDownloadError(
      new TypeError('fetch failed', { cause: transport('connect ECONNRESET', 'ECONNRESET') })
    )
  ).toBe(true)
  expect(
    isRetryableDownloadError(
      new TypeError('terminated', { cause: transport('other side closed', 'UND_ERR_SOCKET') })
    )
  ).toBe(true)
})
