import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from './__fixtures__/gh-api-unknown-escape-flag.json'
import { startCheckJobLogDownload } from './check-job-log-download'
import type { GhCaptureLifetimeHooks } from '../../../git/command-runner/gh-capture-lifetime'
const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }))
vi.mock('../../gh-utils', () => ({ ghExecFileAsync: ghMock }))
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
  it('starts current CLI flagged once and keeps the capture cap', async () => {
    ghMock.mockResolvedValue({ stdout: 'log', stderr: '' })
    await expect(download().result).resolves.toBe('log')
    expect(ghMock).toHaveBeenCalledOnce()
    expect(ghMock.mock.calls[0][0]).toEqual([
      'api',
      'repos/acme/widgets/actions/jobs/77/logs',
      '--allow-escape-sequences'
    ])
    expect(ghMock.mock.calls[0][1]).toMatchObject({ maxBuffer: 64 * 1024 * 1024, timeout: 25_000 })
  })
  it.each([
    fixture.stderr,
    Buffer.from(fixture.stderr),
    diagnostic,
    `${diagnostic}\n`,
    fixture.stderr.replaceAll('\n', '\r\n'),
    fixture.stderr.replaceAll('\n', '\r'),
    `USAGE changed\n${diagnostic}\nflags reordered`,
    `help\n${diagnostic}`,
    `${'changed usage\n'.repeat(500)}${diagnostic}`,
    `${diagnostic}\n${diagnostic}`,
    `HTTP 403\nDEBUG record\necho other text\n${diagnostic}\nauthentication failed`,
    `unknown flag: --other\n${diagnostic}\nindependent failure`
  ])('allows a complete diagnostic independently of surrounding output %#', async (stderr) => {
    ghMock
      .mockRejectedValueOnce(rejected({ stderr, stdout: 'nonempty output is irrelevant' }))
      .mockResolvedValueOnce({ stdout: 'retrieved', stderr: '' })
    await expect(download().result).resolves.toBe('retrieved')
    expect(ghMock).toHaveBeenCalledTimes(2)
    expect(ghMock.mock.calls[1][0]).toEqual(['api', 'repos/acme/widgets/actions/jobs/77/logs'])
    expect(ghMock.mock.calls[1][1]).toEqual(ghMock.mock.calls[0][1])
  })
  it.each([
    `prefix ${diagnostic}`,
    `${diagnostic} suffix`,
    ` ${diagnostic}`,
    `${diagnostic} `,
    diagnostic.toUpperCase(),
    `\x1b[31m${diagnostic}`,
    `${diagnostic}\x00`,
    'unknown flag: --other',
    `${diagnostic}-suffix`,
    `Error: ${diagnostic}`,
    `$ printf '${diagnostic}'`,
    `echo ${diagnostic}`,
    `HTTP 403: ${diagnostic}`,
    `DEBUG ${diagnostic}`,
    JSON.stringify({ error: diagnostic }),
    `"${diagnostic}"`,
    'authentication failed',
    'rate limit exceeded',
    'network unavailable'
  ])('rejects framing or different text on the candidate line %#', async (stderr) => {
    ghMock.mockRejectedValue(rejected({ stderr }))
    await expect(download().result).rejects.toBeDefined()
    expect(ghMock).toHaveBeenCalledOnce()
  })
  it.each([
    { code: 0 },
    { code: undefined },
    { code: null },
    { code: '1' },
    { code: Number.NaN },
    { code: Infinity },
    { code: -Infinity },
    { stderr: undefined },
    { stderr: {} },
    { stderr: null },
    { stderr: '', stdout: diagnostic, message: diagnostic, cause: diagnostic },
    { outputTruncated: true, killed: false, signal: null },
    { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
    { code: 'ENOBUFS' },
    { name: 'AbortError' },
    { code: 'ABORT_ERR' },
    { code: 'ERR_ABORTED' },
    { code: 'ETIMEDOUT' },
    { timedOut: true },
    { killed: true },
    { signal: 'SIGTERM' },
    { signal: false }
  ])('honors typed exclusions before exact stderr %#', async (metadata) => {
    ghMock.mockRejectedValue(rejected(metadata))
    await expect(download().result).rejects.toBeDefined()
    expect(ghMock).toHaveBeenCalledOnce()
  })
  it('does not read inherited stderr or a getter as capture evidence', async () => {
    const inherited = Object.assign(Object.create({ stderr: diagnostic }), { code: 1 })
    ghMock.mockRejectedValueOnce(inherited)
    await expect(download().result).rejects.toBeDefined()
    const getter = vi.fn(() => diagnostic)
    const error = Object.defineProperty({ code: 1 }, 'stderr', { get: getter })
    ghMock.mockRejectedValueOnce(error)
    await expect(download().result).rejects.toBeDefined()
    expect(getter).not.toHaveBeenCalled()
    expect(ghMock).toHaveBeenCalledTimes(2)
  })
  it('accepts other finite nonzero exit codes, with false kill and null signal', async () => {
    ghMock
      .mockRejectedValueOnce(rejected({ code: 2, killed: false, signal: null }))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    await expect(download().result).resolves.toBe('')
    expect(ghMock).toHaveBeenCalledTimes(2)
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
  it('does not reset the original deadline for fallback and starts the next job flagged', async () => {
    ghMock
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 4_000)
        throw rejected({})
      })
      .mockResolvedValueOnce({ stdout: 'ok', stderr: '' })
    await expect(download().result).resolves.toBe('ok')
    expect(ghMock.mock.calls[1][1].timeout).toBe(21_000)
    ghMock.mockResolvedValueOnce({ stdout: 'next', stderr: '' })
    await expect(download().result).resolves.toBe('next')
    expect(ghMock.mock.calls[2][0]).toContain('--allow-escape-sequences')
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
