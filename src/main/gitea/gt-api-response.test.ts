import { describe, expect, it } from 'vitest'
import { parseGtApiResponse, parseGtPaginationTotal } from './gt-api-response'

describe('parseGtApiResponse', () => {
  it('reads the status and lowercased headers from stderr and the body from stdout', () => {
    const stderr = 'HTTP/2.0 200 OK\r\nX-Total-Count: 42\r\nContent-Type: application/json\r\n\r\n'
    expect(parseGtApiResponse('[{"id":1}]', stderr)).toEqual({
      status: 200,
      headers: { 'x-total-count': '42', 'content-type': 'application/json' },
      body: '[{"id":1}]'
    })
  })

  it('reports status 0 when gt printed no status line', () => {
    expect(parseGtApiResponse('', 'boom').status).toBe(0)
  })
})

describe('parseGtPaginationTotal', () => {
  it('parses a non-negative total and ignores bad values', () => {
    expect(parseGtPaginationTotal({ 'x-total-count': '17' })).toBe(17)
    expect(parseGtPaginationTotal({ 'x-total-count': 'abc' })).toBeUndefined()
    expect(parseGtPaginationTotal({})).toBeUndefined()
  })
})
