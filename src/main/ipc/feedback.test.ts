import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) }
}))

import { submitFeedback } from './feedback'

function okResponse(): Response {
  return { ok: true, status: 200 } as unknown as Response
}

function postedBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

describe('submitFeedback', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(okResponse())
  })

  it('strips GitHub identity and anonymous contact fields when submitted anonymously', async () => {
    const anonymousArgs = {
      feedback: 'private bug report',
      submitAnonymously: true,
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com',
      anonymousGithubLogin: 'trusted-user',
      anonymousEmail: 'trusted@example.com',
      anonymousX: 'trusted'
    }
    await submitFeedback(anonymousArgs)

    const body = postedBody()
    expect(body).toMatchObject({
      feedback: 'private bug report',
      githubLogin: null,
      githubEmail: null,
      appVersion: '1.2.3-test'
    })
    expect(body).not.toHaveProperty('anonymousGithubLogin')
    expect(body).not.toHaveProperty('anonymousEmail')
    expect(body).not.toHaveProperty('anonymousX')
  })

  it('preserves verified GitHub identity when not submitted anonymously', async () => {
    await submitFeedback({
      feedback: 'public bug report',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com'
    })

    const body = postedBody()
    expect(body).toMatchObject({
      feedback: 'public bug report',
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com',
      appVersion: '1.2.3-test'
    })
  })
})
