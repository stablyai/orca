import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'
import { runWslProcess } from './wsl-runner'
import { createRunningWslRuntimeRunner } from './wsl-bun-runtime'

vi.mock('../wsl-running-path-filter', () => ({ filterPathsToRunningWslDistrosAsync: vi.fn() }))
vi.mock('./wsl-runner', () => ({ runWslProcess: vi.fn() }))

const probe = vi.mocked(filterPathsToRunningWslDistrosAsync)
const run = vi.mocked(runWslProcess)
const command = { program: 'uname', args: ['-m'], loginPath: 'none' } as const

beforeEach(() => {
  probe.mockImplementation(async (paths) => [...paths])
  run.mockResolvedValue({
    code: 0,
    stdout: 'x86_64\n',
    stderr: '',
    timedOut: false,
    environmentResolved: true
  })
})
afterEach(() => vi.resetAllMocks())

describe('running WSL runtime preparation', () => {
  it('requires a fresh confirmed running verdict before each command', async () => {
    const execution = createRunningWslRuntimeRunner('test-distro')
    expect(await execution.run(command)).toBe('x86_64')
    probe.mockResolvedValueOnce([])
    await expect(execution.run(command)).rejects.toThrow('not running')
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenLastCalledWith(expect.any(Array), { requireConfirmed: true })
    expect(run).toHaveBeenCalledOnce()
  })

  it('never probes or starts a guest for an already cancelled request', async () => {
    const reason = new Error('cancelled by caller')
    const execution = createRunningWslRuntimeRunner('test-distro', AbortSignal.abort(reason))
    await expect(execution.run(command)).rejects.toBe(reason)
    expect(probe).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('does not start a guest when cancellation races the running verdict', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled during probe')
    probe.mockImplementationOnce(async (paths) => {
      controller.abort(reason)
      return [...paths]
    })
    const execution = createRunningWslRuntimeRunner('test-distro', controller.signal)
    await expect(execution.run(command)).rejects.toBe(reason)
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a late successful command after cancellation and prevents the next command', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled during command')
    run.mockImplementationOnce(async () => {
      controller.abort(reason)
      return {
        code: 0,
        stdout: 'late success',
        stderr: '',
        timedOut: false,
        environmentResolved: true
      }
    })
    const execution = createRunningWslRuntimeRunner('test-distro', controller.signal)
    await expect(execution.run(command)).rejects.toBe(reason)
    await expect(execution.run(command)).rejects.toBe(reason)
    expect(run).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledOnce()
  })

  it.each([
    { code: 1, timedOut: false },
    { code: 0, timedOut: true }
  ])('refuses unsuccessful guest results: %j', async (result) => {
    run.mockResolvedValueOnce({
      ...result,
      stdout: 'not a valid result',
      stderr: 'guest failed',
      environmentResolved: true
    })
    await expect(createRunningWslRuntimeRunner('test-distro').run(command)).rejects.toThrow(
      'guest failed'
    )
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        distro: 'test-distro',
        timeoutMs: 15_000,
        maxOutputBytes: 16 * 1024
      })
    )
  })
})
