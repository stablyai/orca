import { describe, expect, it } from 'vitest'
import {
  ClickUpApiError,
  isClickUpAuthError,
  isClickUpTaskUnavailableError,
  toClickUpApiError
} from './clickup-api-error'

const REVOKING_CODES = ['OAUTH_017', 'OAUTH_019', 'OAUTH_021', 'OAUTH_025', 'OAUTH_077']
const WORKSPACE_NOT_AUTHORIZED_CODES = [
  'OAUTH_023',
  'OAUTH_026',
  'OAUTH_027',
  'OAUTH_029',
  'OAUTH_037',
  'OAUTH_045'
]

describe('isClickUpAuthError', () => {
  it.each(REVOKING_CODES)('revokes the credential on %s', (code) => {
    expect(isClickUpAuthError(new ClickUpApiError('Token not found', 401, code))).toBe(true)
  })

  it.each(WORKSPACE_NOT_AUTHORIZED_CODES)('keeps the credential on %s', (code) => {
    expect(isClickUpAuthError(new ClickUpApiError('Team not authorized', 401, code))).toBe(false)
  })

  it('revokes a 401 that carries no error code', () => {
    expect(isClickUpAuthError(new ClickUpApiError('Unauthorized', 401))).toBe(true)
  })

  it('never revokes on a non-401 status', () => {
    expect(isClickUpAuthError(new ClickUpApiError('Forbidden', 403, 'OAUTH_019'))).toBe(false)
  })
})

describe('toClickUpApiError', () => {
  it.each(WORKSPACE_NOT_AUTHORIZED_CODES)(
    'explains %s as a Workspace authorization gap',
    async (code) => {
      const response = new Response(JSON.stringify({ err: 'Team not authorized', ECODE: code }), {
        status: 401
      })
      const error = await toClickUpApiError(response)
      expect(error.code).toBe(code)
      expect(error.message).toContain('not authorized for that Workspace')
      expect(isClickUpAuthError(error)).toBe(false)
    }
  )

  it('keeps ClickUp text for a revoked token', async () => {
    const response = new Response(JSON.stringify({ err: 'Token not found', ECODE: 'OAUTH_019' }), {
      status: 401
    })
    const error = await toClickUpApiError(response)
    expect(error.message).toBe('Token not found')
    expect(isClickUpAuthError(error)).toBe(true)
  })
})

describe('toClickUpApiError on an interrupted body', () => {
  function interruptedUnauthorizedResponse(): Response {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException('This operation was aborted', 'AbortError'))
      }
    })
    return new Response(body, { status: 401 })
  }

  it('propagates the interruption instead of reporting a null-code 401', async () => {
    await expect(toClickUpApiError(interruptedUnauthorizedResponse())).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('keeps the 404 status when the body read fails for a reason other than an abort', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('terminated'))
      }
    })
    const error = await toClickUpApiError(new Response(body, { status: 404 }))
    expect(error.status).toBe(404)
    expect(isClickUpTaskUnavailableError(error)).toBe(true)
  })

  it('propagates a 401 whose body exceeds the cap instead of reporting a null-code 401', async () => {
    const oversized = new Response('x'.repeat(64 * 1024 + 1), { status: 401 })
    await expect(toClickUpApiError(oversized)).rejects.toMatchObject({
      name: 'FetchResponseBodyTooLargeError'
    })
  })

  it('still reports a null-code 401 when a complete body is not JSON', async () => {
    const error = await toClickUpApiError(new Response('Unauthorized', { status: 401 }))
    expect(error.code).toBeNull()
    expect(isClickUpAuthError(error)).toBe(true)
  })
})
