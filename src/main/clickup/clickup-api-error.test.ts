import { describe, expect, it } from 'vitest'
import { ClickUpApiError, isClickUpAuthError, toClickUpApiError } from './clickup-api-error'

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
