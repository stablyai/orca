import { describe, expect, it } from 'vitest'
import { normalizeSentryBaseUrl, parseSentryPagination } from './api-client'

describe('Sentry API client', () => {
  it('normalizes cloud and self-hosted base URLs', () => {
    expect(normalizeSentryBaseUrl('https://sentry.io/')).toBe('https://sentry.io')
    expect(normalizeSentryBaseUrl('https://errors.example.test/sentry/')).toBe(
      'https://errors.example.test/sentry'
    )
  })

  it('rejects credentials embedded in a base URL', () => {
    expect(() => normalizeSentryBaseUrl('https://token@example.test')).toThrow(
      'without credentials'
    )
  })

  it('reads cursors only when the Link entry has results', () => {
    const headers = new Headers({
      link: '<https://sentry.io/api/0/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/api/0/issues/?cursor=0:50:0>; rel="next"; results="true"; cursor="0:50:0"'
    })
    expect(parseSentryPagination(headers)).toEqual({
      nextCursor: '0:50:0',
      previousCursor: null
    })
  })
})
