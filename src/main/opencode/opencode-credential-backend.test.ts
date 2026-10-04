import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import {
  detectOpenCodeCredentialBackend,
  resetOpenCodeCredentialBackendProbes
} from './opencode-credential-backend'

const files = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn() }))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('../ipc/command-path-resolver', () => ({ resolveCommandOnLocalPath: vi.fn() }))
vi.mock('node:fs/promises', () => files)

describe('OpenCode credential execution backend', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetOpenCodeCredentialBackendProbes()
    files.realpath.mockImplementation(async (path: string) => path)
    files.stat.mockResolvedValue({ dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 })
    vi.mocked(resolveCommandOnLocalPath).mockResolvedValue('/task/bin/opencode')
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '1.18.30\n',
      stderr: '',
      timedOut: false
    })
  })

  it.each([
    ['1.18.30\n', 'v1'],
    ['opencode v2.0.16\n', 'v2'],
    ['2.0.16', 'v2'],
    ['opencode v2.0.16-beta.1', 'v2'],
    ['3.0.0', null],
    ['wrapper 2.0.16', null],
    ['', null]
  ])('uses the reported backend for %j', async (stdout, backend) => {
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout,
      stderr: '',
      timedOut: false
    })

    expect(await detectOpenCodeCredentialBackend()).toBe(backend)
  })

  it('resolves and executes the binary in the caller environment with a bounded probe', async () => {
    const environment = { PATH: '/task/bin', XDG_DATA_HOME: '/task/data' }

    await detectOpenCodeCredentialBackend(environment, '/task/workspace')

    expect(resolveCommandOnLocalPath).toHaveBeenCalledExactlyOnceWith('opencode', {
      env: environment,
      cwd: '/task/workspace'
    })
    expect(runProcess).toHaveBeenCalledExactlyOnceWith({
      program: '/task/bin/opencode',
      args: ['--version'],
      env: environment,
      cwd: '/task/workspace',
      timeoutMs: 5_000,
      maxOutputBytes: 1_024
    })
  })

  it('probes opencode2 only when the default opencode command is absent', async () => {
    vi.mocked(resolveCommandOnLocalPath)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/task/bin/opencode2')
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'opencode v2.0.16',
      stderr: '',
      timedOut: false
    })

    expect(await detectOpenCodeCredentialBackend()).toBe('v2')
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/task/bin/opencode2' })
    )
  })

  it.each([
    { code: 1, timedOut: false },
    { code: 0, timedOut: true },
    { code: 0, timedOut: false, outputTruncated: true }
  ])('withholds authority when the installed probe fails: %j', async (failure) => {
    vi.mocked(runProcess).mockResolvedValue({
      ...failure,
      signal: null,
      stdout: 'opencode v2.0.16',
      stderr: ''
    })

    expect(await detectOpenCodeCredentialBackend()).toBeNull()
    expect(resolveCommandOnLocalPath).toHaveBeenCalledTimes(1)
  })

  it('withholds authority after a spawn error without substituting another CLI', async () => {
    vi.mocked(runProcess).mockRejectedValue(new Error('unavailable'))

    expect(await detectOpenCodeCredentialBackend()).toBeNull()
    expect(resolveCommandOnLocalPath).toHaveBeenCalledTimes(1)
  })

  it('withholds authority when neither CLI is installed', async () => {
    vi.mocked(resolveCommandOnLocalPath).mockResolvedValue(null)

    expect(await detectOpenCodeCredentialBackend()).toBeNull()
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('coalesces concurrent calls and reuses a successful binary identity', async () => {
    expect(
      await Promise.all([
        detectOpenCodeCredentialBackend(),
        detectOpenCodeCredentialBackend(),
        detectOpenCodeCredentialBackend()
      ])
    ).toEqual(['v1', 'v1', 'v1'])
    expect(await detectOpenCodeCredentialBackend()).toBe('v1')
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('reprobes when the resolved binary is replaced', async () => {
    expect(await detectOpenCodeCredentialBackend()).toBe('v1')
    files.stat.mockResolvedValue({ dev: 1, ino: 6, size: 3, mtimeMs: 7, ctimeMs: 8 })
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'opencode v2.0.16',
      stderr: '',
      timedOut: false
    })

    expect(await detectOpenCodeCredentialBackend()).toBe('v2')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a probe across caller environments or working directories', async () => {
    await detectOpenCodeCredentialBackend(
      { PATH: '/task/bin', XDG_DATA_HOME: '/task/a' },
      '/task/a'
    )
    await detectOpenCodeCredentialBackend(
      { PATH: '/task/bin', XDG_DATA_HOME: '/task/b' },
      '/task/a'
    )
    await detectOpenCodeCredentialBackend(
      { PATH: '/task/bin', XDG_DATA_HOME: '/task/b' },
      '/task/b'
    )

    expect(runProcess).toHaveBeenCalledTimes(3)
  })

  it('retries an unknown backend after its short cache expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    vi.mocked(runProcess).mockRejectedValueOnce(new Error('temporarily unavailable'))
    try {
      expect(await detectOpenCodeCredentialBackend()).toBeNull()
      expect(await detectOpenCodeCredentialBackend()).toBeNull()
      now.mockReturnValue(6_001)
      expect(await detectOpenCodeCredentialBackend()).toBe('v1')
      expect(runProcess).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('withholds authority when the selected binary identity cannot be read', async () => {
    files.stat.mockRejectedValue(new Error('unreadable executable'))

    expect(await detectOpenCodeCredentialBackend()).toBeNull()
    expect(runProcess).not.toHaveBeenCalled()
  })
})
