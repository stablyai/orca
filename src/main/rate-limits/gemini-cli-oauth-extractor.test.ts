import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { extractOAuthClientCredentials } from './gemini-cli-oauth-extractor'

const files = vi.hoisted(() => ({
  access: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn()
}))
vi.mock('node:fs/promises', () => files)
vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))

function lookupResult() {
  return { code: 0, signal: null, stdout: '/task/bin/gemini', stderr: '', timedOut: false }
}

describe('Gemini OAuth extraction cancellation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(runProcess).mockResolvedValue(lookupResult())
    files.access.mockResolvedValue(undefined)
    files.realpath.mockImplementation(async (path: string) => path)
    files.readFile.mockResolvedValue(
      "OAUTH_CLIENT_ID = 'placeholder-client'; OAUTH_CLIENT_SECRET = 'placeholder-secret'"
    )
  })

  it('keeps the existing known-layout credential discovery working', async () => {
    expect(await extractOAuthClientCredentials()).toEqual({
      clientId: 'placeholder-client',
      clientSecret: 'placeholder-secret'
    })
    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(files.readFile).toHaveBeenCalledTimes(1)
  })

  it('does not launch lookup or read files for an already-cancelled caller', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(extractOAuthClientCredentials(controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(runProcess).not.toHaveBeenCalled()
    expect(files.access).not.toHaveBeenCalled()
    expect(files.readFile).not.toHaveBeenCalled()
  })

  it('passes cancellation to lookup and prevents filesystem fallback after it completes', async () => {
    const controller = new AbortController()
    vi.mocked(runProcess).mockImplementationOnce(async (spec) => {
      controller.abort()
      expect(spec.signal?.aborted).toBe(true)
      return lookupResult()
    })
    await expect(extractOAuthClientCredentials(controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(files.access).not.toHaveBeenCalled()
    expect(files.realpath).not.toHaveBeenCalled()
    expect(files.readFile).not.toHaveBeenCalled()
  })

  it('does not scan further files after an issued read finishes during cancellation', async () => {
    const controller = new AbortController()
    files.readFile.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('read failed')
    })
    await expect(extractOAuthClientCredentials(controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(files.readFile).toHaveBeenCalledTimes(1)
    expect(files.readdir).not.toHaveBeenCalled()
  })
})
