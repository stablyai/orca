import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startCheckJobLogDownload } from './check-job-log-download'
import type { GhCaptureLifetimeHooks } from '../../../git/command-runner/hosted-cli/gh-capture-lifetime'
const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }))
vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghMock
}))
const diagnostic = 'unknown flag: --allow-escape-sequences'
const repo = { owner: 'acme', repo: 'widgets' }
function download(controller = new AbortController(), deadlineAt = Date.now() + 25_000) {
  return startCheckJobLogDownload(
    repo,
    77,
    {
      signal: controller.signal,
      cwd: '/folder',
      host: 'github.com',
      env: { GH_TOKEN: 'fixture-token' }
    },
    deadlineAt,
    vi.fn()
  )
}
function rejected(metadata: Record<string, unknown>) {
  return Object.assign(
    new Error('message supplies no evidence'),
    { code: 1, stderr: diagnostic },
    metadata
  )
}
describe('stateless captured diagnostic negotiation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ghMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('waits positive first termination and starts nothing after cancellation', async () => {
    let close = (): void => {}
    const physical = new Promise<void>((resolve) => {
      close = resolve
    })
    ghMock.mockImplementationOnce((_argv, _options, hooks: GhCaptureLifetimeHooks) => {
      hooks.onTerminationPending(physical)
      return Promise.reject(rejected({}))
    })
    const controller = new AbortController()
    const call = download(controller)
    const rejection = expect(call.result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(ghMock).toHaveBeenCalledOnce()
    controller.abort()
    await rejection
    close()
    await call.terminated
    expect(ghMock).toHaveBeenCalledOnce()
  })

  it('ends at the second failure and rejects expiry or pre-abort without a child', async () => {
    ghMock.mockRejectedValue(rejected({}))
    await expect(download().result).rejects.toBeDefined()
    expect(ghMock).toHaveBeenCalledTimes(2)
    const controller = new AbortController()
    controller.abort()
    await expect(download(controller).result).rejects.toMatchObject({ name: 'AbortError' })
    await expect(download(new AbortController(), Date.now()).result).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(ghMock).toHaveBeenCalledTimes(2)
  })
})
