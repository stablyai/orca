import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { setMainHttpClient } from '../../../network/http-client'

const { fetchMock, sessionFromPartitionMock } = vi.hoisted(() => {
  const fetchMock = vi.fn()
  const cookiesSetMock = vi.fn(() => Promise.resolve())
  const clearStorageDataMock = vi.fn(() => Promise.resolve())
  const sessionFromPartitionMock = vi.fn(() => ({
    clearStorageData: clearStorageDataMock,
    cookies: { set: cookiesSetMock },
    fetch: fetchMock
  }))
  return { clearStorageDataMock, cookiesSetMock, fetchMock, sessionFromPartitionMock }
})
import { redactMiniMaxSecret } from './minimax-request-context'

setMainHttpClient({
  fetch: fetchMock,
  proxySession: () => null,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test only calls clearStorageData, cookies.set and fetch, which the fake provides.
  partitionSession: sessionFromPartitionMock as unknown as (partition: string) => Session
})

describe('redactMiniMaxSecret', () => {
  it('redacts _token values in header and quoted syntax', () => {
    const redacted = redactMiniMaxSecret('cookie _token=eyJhABCDEF and _token:"x.y"')
    expect(redacted).toContain('_token=[REDACTED]')
    expect(redacted).not.toContain('eyJhABCDEF')
    expect(redacted).not.toContain('x.y')
  })

  it('redacts quoted values with whitespace around the colon', () => {
    const redacted = redactMiniMaxSecret('_token : "spaced.secret"')
    expect(redacted).not.toContain('spaced.secret')
    expect(redacted).toContain('_token:[REDACTED]')
  })
})
