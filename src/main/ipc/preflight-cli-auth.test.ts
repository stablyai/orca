import { describe, expect, it, vi } from 'vitest'
import { probeGhAuthentication, probeGlabAuthentication } from './preflight-cli-auth'

describe('preflight CLI authentication', () => {
  it('reads the active GitHub account from structured status output', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            {
              active: true,
              state: 'success'
            }
          ]
        }
      }),
      stderr: ''
    })

    await expect(probeGhAuthentication(run)).resolves.toEqual({
      authenticated: true,
      authState: 'authenticated'
    })
    expect(run).toHaveBeenCalledWith(['auth', 'status', '--active', '--json', 'hosts'])
  })

  it('treats structured GitHub status without a valid active account as unauthenticated', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            {
              active: true,
              state: 'error',
              error: 'HTTP 401: Bad credentials'
            }
          ]
        }
      }),
      stderr: ''
    })

    await expect(probeGhAuthentication(run)).resolves.toEqual({
      authenticated: false,
      authState: 'unauthenticated'
    })
  })

  it('preserves timeout and network failures reported inside structured GitHub output', async () => {
    const timedOutRun = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [{ active: true, state: 'timeout', error: 'request timed out' }]
        }
      }),
      stderr: ''
    })
    const unreachableRun = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            {
              active: true,
              state: 'error',
              error: 'dial tcp: lookup github.com: no such host'
            }
          ]
        }
      }),
      stderr: ''
    })

    await expect(probeGhAuthentication(timedOutRun)).resolves.toEqual({
      authenticated: false,
      authState: 'timeout'
    })
    await expect(probeGhAuthentication(unreachableRun)).resolves.toEqual({
      authenticated: false,
      authState: 'unreachable'
    })
  })

  it.each([
    'Get "https://api.github.com/": Proxy Authentication Required',
    'HTTP 407: Proxy Authentication Required'
  ])(
    'treats a structured GitHub proxy-authentication failure as unreachable: %s',
    async (error) => {
      const run = vi.fn().mockRejectedValue({
        stdout: JSON.stringify({
          hosts: {
            'github.com': [
              {
                active: true,
                state: 'error',
                error
              }
            ]
          }
        }),
        stderr: ''
      })

      await expect(probeGhAuthentication(run)).resolves.toEqual({
        authenticated: false,
        authState: 'unreachable'
      })
      expect(run).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves GitHub timeout and reachability failures instead of reporting logout', async () => {
    const timedOutRun = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Timed out running gh'), { code: 'ETIMEDOUT' }))
    const unreachableRun = vi.fn().mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED github.com:443'), {
        code: 'ECONNREFUSED'
      })
    )

    await expect(probeGhAuthentication(timedOutRun)).resolves.toEqual({
      authenticated: false,
      authState: 'timeout'
    })
    await expect(probeGhAuthentication(unreachableRun)).resolves.toEqual({
      authenticated: false,
      authState: 'unreachable'
    })
  })

  it.each(['unknown flag: --active', 'unknown flag: --json'])(
    'falls back to plain GitHub auth status when the structured probe fails with "%s"',
    async (unsupportedFlagError) => {
      const run = vi
        .fn()
        .mockRejectedValueOnce({ stderr: unsupportedFlagError })
        .mockResolvedValueOnce({
          stdout: 'github.com\n  - Logged in to github.com\n',
          stderr: ''
        })

      await expect(probeGhAuthentication(run)).resolves.toEqual({
        authenticated: true,
        authState: 'authenticated'
      })
      expect(run).toHaveBeenNthCalledWith(2, ['auth', 'status'])
    }
  )

  it('does not retry plain auth status after an unrelated structured probe failure', async () => {
    const run = vi.fn().mockRejectedValueOnce({ stderr: 'failed to read GitHub CLI configuration' })

    await expect(probeGhAuthentication(run)).resolves.toEqual({
      authenticated: false,
      authState: 'error'
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps legacy GitHub success markers emitted with a nonzero exit code', async () => {
    const run = vi.fn().mockRejectedValue({ stderr: 'Logged in to github.com account octocat\n' })

    await expect(probeGhAuthentication(run)).resolves.toEqual({
      authenticated: true,
      authState: 'authenticated'
    })
  })

  it('classifies explicit GitHub logout separately from unknown execution failures', async () => {
    const loggedOutRun = vi
      .fn()
      .mockRejectedValue({ stderr: 'You are not logged into any GitHub hosts.\n' })
    const failedRun = vi.fn().mockRejectedValue(new Error('unexpected gh failure'))

    await expect(probeGhAuthentication(loggedOutRun)).resolves.toEqual({
      authenticated: false,
      authState: 'unauthenticated'
    })
    await expect(probeGhAuthentication(failedRun)).resolves.toEqual({
      authenticated: false,
      authState: 'error'
    })
  })

  it('does not treat ambiguous legacy invalid-token output as confirmed logout', async () => {
    const run = vi.fn().mockRejectedValue({
      stderr: 'authentication failed: the token in hosts.yml is invalid'
    })

    await expect(probeGhAuthentication(run)).resolves.toEqual({
      authenticated: false,
      authState: 'error'
    })
  })

  it('keeps conservative legacy classification after falling back from unsupported flags', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce({ stderr: 'unknown flag: --active' })
      .mockRejectedValueOnce({
        stderr: 'authentication failed: token is no longer valid'
      })

    await expect(probeGhAuthentication(run)).resolves.toEqual({
      authenticated: false,
      authState: 'error'
    })
  })

  it('applies the same authentication failure classes to GitLab CLI', async () => {
    const authenticatedRun = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const loggedOutRun = vi
      .fn()
      .mockRejectedValue({ stderr: 'You are not logged into any GitLab hosts.\n' })
    const unreachableRun = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('network is unreachable'), { code: 'ENETUNREACH' })
      )

    await expect(probeGlabAuthentication(authenticatedRun)).resolves.toEqual({
      authenticated: true,
      authState: 'authenticated'
    })
    await expect(probeGlabAuthentication(loggedOutRun)).resolves.toEqual({
      authenticated: false,
      authState: 'unauthenticated'
    })
    await expect(probeGlabAuthentication(unreachableRun)).resolves.toEqual({
      authenticated: false,
      authState: 'unreachable'
    })
  })
})
