import { describe, expect, it, vi } from 'vitest'
import {
  ComposioKeyRejectedError,
  ComposioNeedsOwnSignInError,
  ComposioUnavailableError,
  isComposioKeyPermissionError
} from './composio-api-errors'
import { ComposioApi } from './composio-api'
import { ComposioKeyAccess, type ComposioKeyStore } from './composio-key-access'

describe('isComposioKeyPermissionError', () => {
  it('identifies 403 APIKey_InsufficientPermissions as key permission error', () => {
    expect(isComposioKeyPermissionError(403, 'APIKey_InsufficientPermissions')).toBe(true)
  })

  it('identifies 403 with session_management write access message', () => {
    const message =
      'This API key does not have the permissions required for POST /api/v3.1/tool_router/session. This route requires "session_management" write access, but the key has read access for "session_management".'
    expect(isComposioKeyPermissionError(403, undefined, message)).toBe(true)
  })

  it('rejects 403 without permission indicators', () => {
    expect(isComposioKeyPermissionError(403, 'Forbidden', 'Access forbidden')).toBe(false)
  })

  it('rejects non-403 statuses even if words mention permission', () => {
    expect(isComposioKeyPermissionError(400, 'Bad_Request', 'Missing permission param')).toBe(false)
  })
})

describe('ComposioApi error classification', () => {
  it('throws ComposioKeyRejectedError on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    )
    const api = new ComposioApi('test-key', fetchImpl)
    await expect(api.createSession('bot-user')).rejects.toThrow(ComposioKeyRejectedError)
  })

  it('throws ComposioKeyRejectedError on 403 with APIKey_InsufficientPermissions', async () => {
    const message =
      'This API key does not have the permissions required for POST /api/v3.1/tool_router/session. This route requires "session_management" write access, but the key has read access for "session_management".'
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Response(
          JSON.stringify({
            error: {
              slug: 'APIKey_InsufficientPermissions',
              message
            }
          }),
          { status: 403, headers: { 'content-type': 'application/json' } }
        )
    )
    const api = new ComposioApi('test-key', fetchImpl)
    await expect(api.createSession('bot-user')).rejects.toThrow(ComposioKeyRejectedError)
    await expect(api.createSession('bot-user')).rejects.toThrow(message)
  })

  it('throws ComposioNeedsOwnSignInError when auth config is required', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { slug: 'ToolRouterV2_NoManagedAuth' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    )
    const api = new ComposioApi('test-key', fetchImpl)
    await expect(api.connectLink('session-1', 'teams')).rejects.toThrow(ComposioNeedsOwnSignInError)
  })

  it('throws ComposioUnavailableError on generic 403', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Forbidden endpoint' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      })
    )
    const api = new ComposioApi('test-key', fetchImpl)
    await expect(api.createSession('bot-user')).rejects.toThrow(ComposioUnavailableError)
  })
})

describe('ComposioKeyAccess health transitions on permission rejection', () => {
  it('marks key state rejected and notifies on session_management permission 403', async () => {
    let savedKey: string | null = 'test-key'
    const keyStore: ComposioKeyStore = {
      read: () => savedKey,
      save: (key) => {
        savedKey = key
      },
      clear: () => {
        savedKey = null
      }
    }
    const onChange = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            slug: 'APIKey_InsufficientPermissions',
            message:
              'This API key does not have the permissions required for POST /api/v3.1/tool_router/session. This route requires "session_management" write access, but the key has read access for "session_management".'
          }
        }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      )
    )
    const access = new ComposioKeyAccess(
      keyStore,
      (key) => new ComposioApi(key, fetchImpl),
      onChange
    )

    expect(await access.keyState()).toBe('ok')

    await expect(access.withKey((api) => api.createSession('bot-1'))).rejects.toThrow(
      ComposioKeyRejectedError
    )

    expect(await access.keyState()).toBe('rejected')
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
