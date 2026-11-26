import { describe, expect, it } from 'vitest'
import { ComposioApi, ComposioKeyScopeError, ComposioUnavailableError } from './composio-api'
import { ComposioKeyHealth } from './composio-key-health'

const forbidden = (slug: string, message: string) => async () =>
  new Response(JSON.stringify({ error: { slug, message } }), { status: 403 })

const SESSION_WRITE =
  'This API key does not have the permissions required for POST /api/v3.1/tool_router/session. This route requires "session_management" write access, but the key has read access for "session_management".'

describe('Composio 403s', () => {
  it('names the permission a scoped key lacks, without refusing the key', async () => {
    const api = new ComposioApi('key', forbidden('APIKey_InsufficientPermissions', SESSION_WRITE))
    const error = await api.createSession('user').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ComposioKeyScopeError)
    expect(error).toMatchObject({
      message:
        'This Composio key can’t create sessions. It needs Session management: Read and write.',
      data: {
        botFailure: {
          code: 'composioKeyCantCreateSessions',
          params: { permission: 'Session management: Read and write' }
        }
      }
    })
    const health = new ComposioKeyHealth(() => {})
    health.failed(error)
    expect(health.rejected).toBe(false)
  })

  it('names other access needs, and still offers a key change when Composio names none', async () => {
    const sessionRead = new ComposioApi(
      'key',
      forbidden(
        'APIKey_InsufficientPermissions',
        'This route requires "session_management" read access, but the key has write access.'
      )
    )
    await expect(sessionRead.disconnect('ca_1')).rejects.toThrow(
      'This Composio key is missing a permission. It needs Session management: Read.'
    )
    const unnamed = new ComposioApi('key', forbidden('APIKey_InsufficientPermissions', 'Denied.'))
    await expect(unnamed.app('notion')).rejects.toThrow(
      'This Composio key is missing a permission Orca needs.'
    )
  })

  it('keeps any other 403 as Composio worded it', async () => {
    const api = new ComposioApi('key', forbidden('Project_Suspended', 'This project is suspended.'))
    const error = await api.app('notion').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ComposioUnavailableError)
    expect(error).toMatchObject({ message: 'Composio: This project is suspended.' })
  })
})
