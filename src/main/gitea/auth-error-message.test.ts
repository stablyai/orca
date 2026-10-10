import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeGiteaAuthenticatedUser, sanitizeGiteaAuthError } from './auth-error-message'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sanitizeGiteaAuthError', () => {
  it('redacts the configured token from Gitea auth error text', () => {
    expect(
      sanitizeGiteaAuthError('bad token secret-token-value in response', 'secret-token-value')
    ).toBe('bad token [REDACTED] in response')
  })

  it('returns null for blank input', () => {
    expect(sanitizeGiteaAuthError('   ', null)).toBeNull()
  })
})

describe('probeGiteaAuthenticatedUser', () => {
  it('keeps the Gitea JSON message on non-2xx auth probes', async () => {
    const message =
      'token does not have at least one of required scope(s), required=[read:user], token scope=write:package'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ message, url: 'https://git.example.com/api/swagger' }, { status: 403 })
      )
    )

    await expect(
      probeGiteaAuthenticatedUser('https://git.example.com/api/v1', 'secret-token-value')
    ).resolves.toEqual({
      user: null,
      authError: message
    })
  })

  it('uses the HTTP fallback for a JSON null error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(null, { status: 403 }))
    )

    await expect(
      probeGiteaAuthenticatedUser('https://git.example.com/api/v1', 'secret-token-value')
    ).resolves.toEqual({
      user: null,
      authError: 'HTTP 403'
    })
  })

  it('cancels an oversized error body and uses the HTTP fallback', async () => {
    let cancelled = false
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(64 * 1024))
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10))
          controller.close()
        }
      },
      cancel() {
        cancelled = true
      }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 403 }))
    )

    await expect(
      probeGiteaAuthenticatedUser('https://git.example.com/api/v1', 'secret-token-value')
    ).resolves.toEqual({
      user: null,
      authError: 'HTTP 403'
    })
    expect(cancelled).toBe(true)
  })
})
