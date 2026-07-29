import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock, handlers } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) }
}))

import { registerFeedbackHandlers, submitFeedback } from './feedback'

function okResponse(): Response {
  return { ok: true, status: 200 } as unknown as Response
}

function errorResponse(status: number): Response {
  return { ok: false, status } as unknown as Response
}

function requestInit(callIndex = 0): RequestInit {
  return fetchMock.mock.calls[callIndex]?.[1] as RequestInit
}

function postedBody(callIndex = 0): Record<string, unknown> {
  return JSON.parse(String(requestInit(callIndex).body)) as Record<string, unknown>
}

function diagnosticSubmitArgs(): Parameters<typeof submitFeedback>[0] {
  return {
    feedback: '[Crash Report]\n\nDiagnostic log:\n- Status: attached',
    feedbackWithoutDiagnosticBundle:
      '[Crash Report]\n\nDiagnostic log:\n- Status: not uploaded\n- Reason: attachment failed',
    submissionType: 'crash',
    submitAnonymously: true,
    githubLogin: null,
    githubEmail: null,
    diagnosticBundle: {
      bundleSubmissionId: 'bundleabcdefghijklmnop',
      content: '{"type":"bundle-header"}\n',
      bytes: 25,
      spanCount: 1
    }
  }
}

describe('submitFeedback', () => {
  beforeEach(() => {
    vi.useRealTimers()
    handlers.clear()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(okResponse())
  })

  afterEach(() => {
    vi.useRealTimers()
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
      submissionType: 'feedback',
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
      submissionType: 'feedback',
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com',
      appVersion: '1.2.3-test'
    })
  })

  it('preserves crash submissions for the crash report lane', async () => {
    await submitFeedback({
      feedback: '[Crash Report]',
      submissionType: 'crash',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null
    } as Parameters<typeof submitFeedback>[0])

    expect(postedBody()).toMatchObject({
      feedback: '[Crash Report]',
      submissionType: 'crash',
      githubLogin: 'trusted-user',
      githubEmail: null
    })
  })

  it('attaches diagnostic bundles only to crash submissions', async () => {
    const diagnosticBundle = {
      bundleSubmissionId: 'bundleabcdefghijklmnop',
      content: '{"type":"bundle-header"}\n',
      bytes: 25,
      spanCount: 1
    }
    await submitFeedback({
      feedback: '[Crash Report]',
      submissionType: 'crash',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null,
      diagnosticBundle
    } as Parameters<typeof submitFeedback>[0])
    await submitFeedback({
      feedback: 'normal feedback',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null,
      diagnosticBundle
    } as Parameters<typeof submitFeedback>[0])

    const crashInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    const feedbackInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined
    const crashFormData = crashInit?.body as FormData
    expect(crashFormData).toBeInstanceOf(FormData)
    expect(crashInit?.headers).toBeUndefined()
    expect(crashFormData.get('submissionType')).toBe('crash')
    expect(crashFormData.get('diagnosticBundleSubmissionId')).toBe(
      diagnosticBundle.bundleSubmissionId
    )
    expect(crashFormData.get('diagnosticBundleBytes')).toBe(String(diagnosticBundle.bytes))
    expect(crashFormData.get('diagnosticBundleSpanCount')).toBe(String(diagnosticBundle.spanCount))
    const file = crashFormData.get('diagnosticBundleFile')
    expect(file).toBeInstanceOf(Blob)
    await expect((file as Blob).text()).resolves.toBe(diagnosticBundle.content)
    expect(JSON.parse(String(feedbackInit?.body))).not.toHaveProperty('diagnosticBundle')
  })

  it('retries a rejected diagnostic attachment as report-only JSON on the website API', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(413)).mockResolvedValueOnce(okResponse())

    await expect(submitFeedback(diagnosticSubmitArgs())).resolves.toEqual({
      ok: true,
      diagnosticBundleFailure: { status: 413, error: 'status 413' }
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://www.onorca.dev/v1/feedback')
    expect(requestInit(0).body).toBeInstanceOf(FormData)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.onorca.dev/v1/feedback')
    expect(requestInit(1).headers).toEqual({
      'Content-Type': 'application/json'
    })
    expect(postedBody(1)).toMatchObject({
      feedback:
        '[Crash Report]\n\nDiagnostic log:\n- Status: not uploaded\n- Reason: attachment failed',
      submissionType: 'crash'
    })
    expect(postedBody(1)).not.toHaveProperty('diagnosticBundle')
  })

  it('retries a diagnostic attachment server error as report-only JSON on the website API', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(502)).mockResolvedValueOnce(okResponse())

    await expect(submitFeedback(diagnosticSubmitArgs())).resolves.toEqual({
      ok: true,
      diagnosticBundleFailure: { status: 502, error: 'status 502' }
    })

    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.onorca.dev/v1/feedback')
    expect(requestInit(1).headers).toEqual({ 'Content-Type': 'application/json' })
    expect(postedBody(1)).not.toHaveProperty('diagnosticBundle')
  })

  it('retries a diagnostic attachment network error as report-only JSON on the website API', async () => {
    fetchMock.mockRejectedValueOnce(new Error('attachment network failed'))
    fetchMock.mockResolvedValueOnce(okResponse())

    await expect(submitFeedback(diagnosticSubmitArgs())).resolves.toEqual({
      ok: true,
      diagnosticBundleFailure: { status: null, error: 'attachment network failed' }
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.onorca.dev/v1/feedback')
    expect(requestInit(1).body).not.toBeInstanceOf(FormData)
    expect(postedBody(1)).not.toHaveProperty('diagnosticBundle')
  })

  it('allows 60 seconds for a diagnostic attachment before retrying report-only JSON', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('runtime abort text')))
      })
    })
    fetchMock.mockResolvedValueOnce(okResponse())
    const result = submitFeedback(diagnosticSubmitArgs())

    await vi.advanceTimersByTimeAsync(59_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toEqual({
      ok: true,
      diagnosticBundleFailure: { status: null, error: 'request timed out after 60 seconds' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.onorca.dev/v1/feedback')
    expect(postedBody(1)).not.toHaveProperty('diagnosticBundle')
  })

  it('retries a proxy-rejected diagnostic attachment as website JSON', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403)).mockResolvedValueOnce(okResponse())

    await expect(submitFeedback(diagnosticSubmitArgs())).resolves.toEqual({
      ok: true,
      diagnosticBundleFailure: { status: 403, error: 'status 403' }
    })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.onorca.dev/v1/feedback')
    expect(requestInit(1).body).not.toBeInstanceOf(FormData)
  })

  it.each([401, 409, 429])(
    'does not retry a diagnostic attachment rejected with status %s',
    async (status) => {
      fetchMock.mockResolvedValueOnce(errorResponse(status))

      await expect(submitFeedback(diagnosticSubmitArgs())).resolves.toEqual({
        ok: false,
        status,
        error: `status ${status}`
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves attachment and report-only failures when the degraded retry fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('attachment network failed'))
    fetchMock.mockRejectedValueOnce(new Error('report-only network failed'))

    await expect(submitFeedback(diagnosticSubmitArgs())).resolves.toEqual({
      ok: false,
      status: null,
      error: 'report-only network failed',
      diagnosticBundleFailure: { status: null, error: 'attachment network failed' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries the website API when the primary feedback request stalls', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')))
      })
    })
    fetchMock.mockResolvedValueOnce(okResponse())

    const result = submitFeedback({
      feedback: 'stalled primary',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com'
    })
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(Promise.race([result, Promise.resolve('pending')])).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://www.onorca.dev/v1/feedback',
      'https://www.onorca.dev/v1/feedback'
    ])
  })

  it('does not retry a non-diagnostic 404', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404))

    await expect(
      submitFeedback({
        feedback: 'missing feedback route',
        submitAnonymously: true,
        githubLogin: null,
        githubEmail: null
      })
    ).resolves.toEqual({ ok: false, status: 404, error: 'status 404' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://www.onorca.dev/v1/feedback')
  })

  it('does not retry again when the website retry stalls after a primary server error', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(errorResponse(500))
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('retry aborted')))
      })
    })

    const result = submitFeedback({
      feedback: 'primary 500 and retry stalled',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com'
    })
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(Promise.race([result, Promise.resolve('pending')])).resolves.toEqual({
      ok: false,
      status: null,
      error: 'status 500; retry: request timed out after 10 seconds'
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://www.onorca.dev/v1/feedback',
      'https://www.onorca.dev/v1/feedback'
    ])
  })

  it('preserves the primary status when a same-host retry also returns a server error', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(502)).mockResolvedValueOnce(errorResponse(503))

    await expect(
      submitFeedback({
        feedback: 'primary and retry both server errors',
        submitAnonymously: true,
        githubLogin: null,
        githubEmail: null
      })
    ).resolves.toEqual({
      ok: false,
      status: 503,
      error: 'status 502; retry: status 503'
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('posts to the website API first so crash reports use the snippet-capable route', async () => {
    await submitFeedback({
      feedback: '[Crash Report]',
      submissionType: 'crash',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
    } as Parameters<typeof submitFeedback>[0])

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://www.onorca.dev/v1/feedback')
  })

  it('forces renderer IPC submissions onto the feedback lane', async () => {
    registerFeedbackHandlers()
    await handlers.get('feedback:submit')?.(null, {
      feedback: 'not a crash report',
      submissionType: 'crash',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null
    })

    expect(postedBody()).toMatchObject({
      feedback: 'not a crash report',
      submissionType: 'feedback',
      githubLogin: 'trusted-user',
      githubEmail: null
    })
  })
})
