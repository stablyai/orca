import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeGiteaAuthenticatedUser, sanitizeGiteaAuthError } from './auth-error-message'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sanitizeGiteaAuthError', () => {
  it('redacts configured tokens, credential query parameters, and auth headers', () => {
    expect(
      sanitizeGiteaAuthError('bad token secret-token-value in response', 'secret-token-value')
    ).toBe('bad token [REDACTED] in response')

    const urlInput =
      'https://git.example.com/auth?access_token=a1&token=b2&key=c3&private_token=d4&api_key=e5&api-key=f6&client_secret=g7&password=h8&passphrase=i9&ok=kept'
    expect(sanitizeGiteaAuthError(urlInput, null)).toBe(
      'https://git.example.com/auth?access_token=[REDACTED]&token=[REDACTED]&key=[REDACTED]&private_token=[REDACTED]&api_key=[REDACTED]&api-key=[REDACTED]&client_secret=[REDACTED]&password=[REDACTED]&passphrase=[REDACTED]&ok=kept'
    )

    expect(
      sanitizeGiteaAuthError(
        'https://git.example.com/auth?password=,secret-password&token=prefix,suffix&api_key=abc]private&client_secret=]full}secret&ok=kept',
        null
      )
    ).toBe(
      'https://git.example.com/auth?password=[REDACTED]&token=[REDACTED]&api_key=[REDACTED]&client_secret=[REDACTED]&ok=kept'
    )

    expect(
      sanitizeGiteaAuthError(
        'headers: Authorization: token t123 authorization=Bearer b456 Authorization: Basic ZHVtbXk=',
        null
      )
    ).toBe(
      'headers: Authorization: token [REDACTED] authorization=Bearer [REDACTED] Authorization: Basic [REDACTED]'
    )

    expect(
      sanitizeGiteaAuthError(
        '{"Authorization":"Basic dXNlcjpzZWNyZXQtdG9rZW4=","authorization": "Bearer bearer-secret", "url": "https://git.example.com?private_token=s1"}',
        null
      )
    ).toBe(
      '{"Authorization":"Basic [REDACTED]","authorization": "Bearer [REDACTED]", "url": "https://git.example.com?private_token=[REDACTED]"}'
    )

    expect(
      sanitizeGiteaAuthError(
        String.raw`{"Authorization":["Basic dXNlcjpzZWNyZXQ="],"raw":"{\"Authorization\":\"Bearer esc1\"}"}`,
        null
      )
    ).toBe(
      String.raw`{"Authorization":["Basic [REDACTED]"],"raw":"{\"Authorization\":\"Bearer [REDACTED]\"}"}`
    )

    expect(
      sanitizeGiteaAuthError(
        '{"Authorization":["Bearer first-secret","Bearer second-secret"]}',
        null
      )
    ).toBe('{"Authorization":["Bearer [REDACTED]","Bearer [REDACTED]"]}')

    expect(
      sanitizeGiteaAuthError("https://git.example.com/O'Reilly?password=prefix'secret&ok=1", null)
    ).toBe("https://git.example.com/O'Reilly?password=[REDACTED]&ok=1")

    expect(
      sanitizeGiteaAuthError(
        String.raw`https://user:pass@git.example.com/auth?password=\secret&api_key="quoted-secret"&ok=kept`,
        null
      )
    ).toBe(
      'https://user:[REDACTED]@git.example.com/auth?password=[REDACTED]&api_key=[REDACTED]&ok=kept'
    )

    expect(sanitizeGiteaAuthError('https://git.example.com:8443/api/v1/user?email=a@b', null)).toBe(
      'https://git.example.com:8443/api/v1/user?email=a@b'
    )

    expect(
      sanitizeGiteaAuthError(
        String.raw`bad url ?password=prefix'secret&token=\"secret\"&ok=1`,
        null
      )
    ).toBe('bad url ?password=[REDACTED]&token=[REDACTED]&ok=1')

    expect(
      sanitizeGiteaAuthError(
        '{"Authorization":["Bearer configured-secret","Bearer second-secret"]}',
        'configured-secret'
      )
    ).toBe('{"Authorization":["Bearer [REDACTED]","Bearer [REDACTED]"]}')

    expect(
      sanitizeGiteaAuthError("'https://git.example.com/?password=prefix'secret&ok=1'", null)
    ).toBe("'https://git.example.com/?password=[REDACTED]&ok=1'")

    expect(sanitizeGiteaAuthError("'https://git.example.com/?password=prefix'secret'", null)).toBe(
      "'https://git.example.com/?password=[REDACTED]'"
    )

    expect(
      sanitizeGiteaAuthError('https://oauth-token@git.example.com/?%74oken=query-secret&ok=1', null)
    ).toBe('https://[REDACTED]@git.example.com/?%74oken=[REDACTED]&ok=1')

    expect(
      sanitizeGiteaAuthError(
        '<a href="https://git.example/?ok=1&amp;password=hunter2&amp;token=tok2">retry</a>',
        null
      )
    ).toBe(
      '<a href="https://git.example/?ok=1&amp;password=[REDACTED]&amp;token=[REDACTED]">retry</a>'
    )

    expect(
      sanitizeGiteaAuthError('https://git.example/?ok=1&#38;password=hunter3&ok=2', null)
    ).toBe('https://git.example/?ok=1&#38;password=[REDACTED]&ok=2')

    expect(sanitizeGiteaAuthError("Authorization: token prefix'secret next", null)).toBe(
      'Authorization: token [REDACTED] next'
    )

    expect(sanitizeGiteaAuthError('"Authorization": "Bearer unclosed-secret', null)).toBe(
      '"Authorization": "Bearer [REDACTED]'
    )

    const adversarialBackslash = `Authorization: [${'\\'.repeat(48)}"`
    expect(sanitizeGiteaAuthError(adversarialBackslash, null)).toBe(adversarialBackslash)

    expect(sanitizeGiteaAuthError('{"Authorization":["Bearer a]b","Basic c,d"]}', null)).toBe(
      '{"Authorization":["Bearer [REDACTED]","Basic [REDACTED]"]}'
    )
  })

  it('returns null for blank input and truncates long messages', () => {
    expect(sanitizeGiteaAuthError('   \n\t ', null)).toBeNull()

    const truncated = sanitizeGiteaAuthError('a'.repeat(300), null)
    expect(truncated).toBe(`${'a'.repeat(277)}...`)
    expect(truncated?.length).toBe(280)
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

  it('cancels an oversized error body synchronously and uses the HTTP fallback', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8 * 1024))
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

  it('parses the authenticated user probe cleanly on 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { login: 'octocat', username: 'octocat', full_name: 'Octo Cat' },
          { status: 200 }
        )
      )
    )

    await expect(
      probeGiteaAuthenticatedUser('https://git.example.com/api/v1', 'secret-token-value')
    ).resolves.toEqual({
      user: { login: 'octocat', username: 'octocat', full_name: 'Octo Cat' },
      authError: null
    })
  })
})
