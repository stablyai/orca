import { beforeEach, describe, expect, it, vi } from 'vitest'

const { teaExecFileAsyncMock } = vi.hoisted(() => ({ teaExecFileAsyncMock: vi.fn() }))

vi.mock('../git/command-runner/tea-exec-file', () => ({
  teaExecFileAsync: teaExecFileAsyncMock
}))

import { parseTeaApiResponse, parseTeaPaginationTotal, teaApiWithHeaders } from './tea-api-response'

describe('parseTeaApiResponse', () => {
  it('reads HTTP status and lowercase headers from stderr and JSON from stdout', () => {
    const parsed = parseTeaApiResponse(
      '{"id":1}',
      'HTTP/1.1 200 OK\r\nX-Total-Count: 42\r\nX-RateLimit-Remaining: 59\r\n\r\n'
    )
    expect(parsed.status).toBe(200)
    expect(parsed.headers).toEqual({
      'x-total-count': '42',
      'x-ratelimit-remaining': '59'
    })
    expect(parsed.body).toBe('{"id":1}')
  })

  it('keeps a pure JSON stdout body when stderr has no header block', () => {
    const parsed = parseTeaApiResponse('[]', '')
    expect(parsed).toEqual({ status: 0, headers: {}, body: '[]' })
  })

  it('reads x-total-count as a pagination total', () => {
    expect(parseTeaPaginationTotal({ 'x-total-count': '42' })).toBe(42)
    expect(parseTeaPaginationTotal({})).toBeUndefined()
    expect(parseTeaPaginationTotal({ 'x-total-count': 'nope' })).toBeUndefined()
  })
})

describe('teaApiWithHeaders', () => {
  beforeEach(() => {
    teaExecFileAsyncMock.mockReset()
  })

  it('requests tea api -i and parses stderr headers separately from stdout', async () => {
    teaExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '{"login":"alice"}',
      stderr: 'HTTP/1.1 200 OK\r\nX-RateLimit-Limit: 60\r\n\r\n'
    })

    await expect(teaApiWithHeaders(['/user'], { timeout: 5_000 })).resolves.toEqual({
      status: 200,
      headers: { 'x-ratelimit-limit': '60' },
      body: '{"login":"alice"}'
    })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(['api', '-i', '/user'], { timeout: 5_000 })
  })
})
