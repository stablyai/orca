import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { closeAllConnectionsMock, netFetchMock, resolveProxyMock, setProxyMock } = vi.hoisted(
  () => ({
    closeAllConnectionsMock: vi.fn(),
    netFetchMock: vi.fn(),
    resolveProxyMock: vi.fn(),
    setProxyMock: vi.fn()
  })
)

async function loadJiraRequestModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    net: { fetch: netFetchMock },
    session: {
      defaultSession: {
        closeAllConnections: closeAllConnectionsMock,
        resolveProxy: resolveProxyMock,
        setProxy: setProxyMock
      }
    }
  }))

  return import('./jira-request')
}

beforeEach(() => {
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  closeAllConnectionsMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Jira authenticated request transport', () => {
  it('rejects HTTP Jira site URLs before sending credentials', async () => {
    const jira = await loadJiraRequestModule()

    await expect(
      jira.jiraRequestWithAuthorization(
        'http://jira.example.internal',
        'Bearer secret-token',
        '/rest/api/2/myself'
      )
    ).rejects.toMatchObject({
      message: 'Jira sites must use HTTPS to send credentials.',
      status: null
    })

    expect(resolveProxyMock).not.toHaveBeenCalled()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('aborts stalled Jira requests after the request timeout', async () => {
    vi.useFakeTimers()
    let capturedSignal: AbortSignal | undefined
    netFetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      if (!capturedSignal) {
        return Promise.reject(new Error('missing abort signal'))
      }
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener(
          'abort',
          () => {
            reject(capturedSignal?.reason)
          },
          { once: true }
        )
      })
    })
    const jira = await loadJiraRequestModule()

    const request = jira
      .jiraRequestWithAuthorization(
        'https://jira.example.internal',
        'Bearer secret-token',
        '/rest/api/2/myself'
      )
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)

    expect(resolveProxyMock).toHaveBeenCalledWith('https://jira.example.internal/rest/api/2/myself')
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
    expect(capturedSignal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(jira.JIRA_REQUEST_TIMEOUT_MS)

    await expect(request).resolves.toMatchObject({
      message: 'Jira request timed out.',
      status: null
    })
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('times out Jira requests when proxy setup stalls', async () => {
    vi.useFakeTimers()
    resolveProxyMock.mockReturnValueOnce(new Promise(() => {}))
    const jira = await loadJiraRequestModule()

    const request = jira
      .jiraRequestWithAuthorization(
        'https://jira.example.internal',
        'Bearer secret-token',
        '/rest/api/2/myself'
      )
      .catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(jira.JIRA_REQUEST_TIMEOUT_MS)

    // Why: this guards the regression where proxy setup hangs before net.fetch
    // runs; the assertion should fail immediately instead of waiting for Vitest.
    const outcome = await Promise.race([request, Promise.resolve('pending')])
    expect(outcome).toMatchObject({
      message: 'Jira request timed out.',
      status: null
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})
