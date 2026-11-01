import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capture, resolveCommandMock, fallbackMock } = vi.hoisted(() => ({
  capture: vi.fn(),
  resolveCommandMock: vi.fn(),
  fallbackMock: vi.fn()
}))

vi.mock('../git/command-runner/exec-file-capture', () => ({
  execFileCaptureToTermination: capture
}))

vi.mock('../git/command-runner/wsl-command-resolution', () => ({
  resolveCommand: resolveCommandMock
}))

vi.mock('../git/command-runner/default-wsl-cli-fallback', () => ({
  resolveDefaultWslCliFallback: fallbackMock
}))

import { teaExecFileAsync } from '../git/command-runner/tea-exec-file'
import { acquire, release } from './tea-admission'

const originalPlatform = process.platform

function resolvedTea(args: string[]) {
  return {
    binary: 'tea',
    args,
    cwd: undefined,
    wsl: null,
    wslMode: null
  }
}

function transient(stderr: string): Error {
  return Object.assign(new Error(stderr), { stderr })
}

describe('teaExecFileAsync', () => {
  beforeEach(() => {
    capture.mockReset()
    fallbackMock.mockReset()
    resolveCommandMock.mockReset()
    resolveCommandMock.mockImplementation((_command: string, args: string[]) => resolvedTea(args))
    capture.mockResolvedValue({ stdout: '{}', stderr: '' })
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('forwards GITEA_INSTANCE_URL and GITEA_TOKEN through WSLENV on Windows', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await teaExecFileAsync(['login', 'list', '-o', 'json'], {
      env: {
        GITEA_INSTANCE_URL: 'https://codeberg.org',
        GITEA_TOKEN: 'token-value'
      }
    })

    // SAFETY: the mock is only ever invoked with the options object under test.
    const options = capture.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv; stdin?: string }
    expect(options.env?.GITEA_INSTANCE_URL).toBe('https://codeberg.org')
    expect(options.env?.GITEA_TOKEN).toBe('token-value')
    expect(options.env?.WSLENV?.split(':')).toEqual(
      expect.arrayContaining(['GITEA_INSTANCE_URL', 'GITEA_TOKEN'])
    )
    expect(options.stdin).toBe('')
  })

  it('does not rewrite WSLENV outside Windows', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })

    await teaExecFileAsync(['login', 'list'], {
      env: { GITEA_TOKEN: 'token-value', WSLENV: 'EXISTING' }
    })

    // SAFETY: the mock is only ever invoked with the options object under test.
    const options = capture.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }
    expect(options.env?.WSLENV).toBe('EXISTING')
  })

  it('maps Orca token and API base URL onto tea env names', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })

    await teaExecFileAsync(['api', '/user'], {
      env: {
        ORCA_GITEA_TOKEN: 'orca-token',
        ORCA_GITEA_API_BASE_URL: 'https://git.example.com'
      }
    })

    // SAFETY: the mock is only ever invoked with the options object under test.
    const options = capture.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }
    expect(options.env?.GITEA_TOKEN).toBe('orca-token')
    expect(options.env?.GITEA_INSTANCE_URL).toBe('https://git.example.com')
  })

  it('retries idempotent tea api GET calls on transient 502 and 503 errors', async () => {
    vi.useFakeTimers()
    capture
      .mockRejectedValueOnce(transient('HTTP 502 Bad Gateway'))
      .mockRejectedValueOnce(transient('HTTP 503 Service Unavailable'))
      .mockResolvedValueOnce({ stdout: '{"ok":true}', stderr: '' })

    const pending = teaExecFileAsync(['api', '/user'])
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toEqual({ stdout: '{"ok":true}', stderr: '' })
    expect(capture).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['api', '-X', 'POST', '/repos/o/r/issues'],
    ['api', '-X', 'PATCH', '/repos/o/r/issues/1'],
    ['api', '-X', 'DELETE', '/repos/o/r/issues/1'],
    ['issues', 'create'],
    ['repos', 'edit'],
    ['pulls', 'merge']
  ])('does not retry non-idempotent %j', async (...args) => {
    capture.mockRejectedValueOnce(transient('HTTP 502 Bad Gateway'))

    await expect(teaExecFileAsync(args)).rejects.toThrow('HTTP 502 Bad Gateway')
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default WSL distro when host tea is missing', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    capture.mockRejectedValueOnce(
      Object.assign(new Error('spawn tea ENOENT'), { code: 'ENOENT', syscall: 'spawn tea' })
    )
    fallbackMock.mockResolvedValueOnce({
      binary: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--exec', 'bash', '-c', "'tea' 'api' '/user'"],
      cwd: undefined,
      wsl: { distro: 'Ubuntu', distroPath: '/home' },
      wslMode: 'login-shell'
    })
    capture.mockResolvedValueOnce({ stdout: '[]', stderr: '' })

    await expect(teaExecFileAsync(['api', '/user'])).resolves.toEqual({ stdout: '[]', stderr: '' })
    expect(fallbackMock).toHaveBeenCalledWith('tea', ['api', '/user'])
  })

  it('does not wake the default WSL distro when fallback is disabled', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    capture.mockRejectedValueOnce(
      Object.assign(new Error('spawn tea ENOENT'), { code: 'ENOENT', syscall: 'spawn tea' })
    )

    await expect(
      teaExecFileAsync(['login', 'status', '-o', 'json'], { allowDefaultWslFallback: false })
    ).rejects.toThrow('ENOENT')
    expect(fallbackMock).not.toHaveBeenCalled()
  })
})

describe('tea admission', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('admits four concurrent callers and queues the fifth until release', async () => {
    await Promise.all([acquire(), acquire(), acquire(), acquire()])
    let granted = false
    const fifth = acquire(1_000).then(() => {
      granted = true
    })
    await Promise.resolve()
    expect(granted).toBe(false)

    release()
    await fifth
    expect(granted).toBe(true)
    release()
    release()
    release()
    release()
  })
})
