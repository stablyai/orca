import { describe, expect, it, vi } from 'vitest'
import { skillCloudRequest, type SkillCloudRequestError } from './skill-cloud-request'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

describe('skillCloudRequest', () => {
  it('bounds requests that do not have a caller-owned cancellation signal', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    ) as typeof fetch
    const request = skillCloudRequest({
      apiUrl: 'http://127.0.0.1:8787',
      path: '/v1/skill-shares/share_1',
      fetcher,
      timeoutMs: 100
    })
    const expectation = expect(request).rejects.toThrow('skill-cloud-request-timeout')

    await vi.advanceTimersByTimeAsync(100)
    await expectation
    vi.useRealTimers()
  })

  it('sends credentials only to the validated Orca origin', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8787/v1/skill-shares/share_1')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-token')
      expect(init?.redirect).toBe('error')
      return Response.json({ share: { id: 'share_1' } })
    }) as typeof fetch
    await expect(
      skillCloudRequest({
        apiUrl: 'http://127.0.0.1:8787',
        authToken: 'private-token',
        path: '/v1/skill-shares/share_1',
        fetcher
      })
    ).resolves.toEqual({ share: { id: 'share_1' } })
  })

  it('omits authorization for bearer-link requests', async () => {
    const fetcher = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return Response.json({ share: { id: 'share_1' } })
    }) as typeof fetch
    await skillCloudRequest({
      apiUrl: 'http://127.0.0.1:8787',
      path: '/v1/skill-shares/share_1',
      fetcher
    })
  })

  it('rejects non-API paths and returns structured errors without response contents', async () => {
    await expect(
      skillCloudRequest({
        apiUrl: 'http://127.0.0.1:8787',
        authToken: 'token',
        path: 'https://attacker.test/v1/skills'
      })
    ).rejects.toThrow('skill-cloud-request-path-invalid')
    const fetcher = vi.fn(async () =>
      Response.json({ code: 'skill_share_not_found', private: 'do-not-reflect' }, { status: 404 })
    ) as typeof fetch
    const request = skillCloudRequest({
      apiUrl: 'http://127.0.0.1:8787',
      authToken: 'token',
      path: '/v1/skill-shares/missing',
      fetcher
    })
    await expect(request).rejects.toMatchObject({
      statusCode: 404,
      code: 'skill_share_not_found',
      message: 'The skill Cloud request failed.'
    } satisfies Partial<SkillCloudRequestError>)
  })
})
