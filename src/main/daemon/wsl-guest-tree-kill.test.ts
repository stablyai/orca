import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWslGuestTreeKillArgs,
  runWslGuestTreeKill,
  WSL_GUEST_TREE_KILL_TIMEOUT_MS,
  type WslGuestTreeKillRunner
} from './wsl-guest-tree-kill'
import { resolveBundledGuestTreeKillArtifact } from '../pty/bundled-guest-tree-kill'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import type { ProcessResult } from '../../shared/child-process/run-process'

vi.mock('../wsl/wsl-executable-path', () => ({
  resolveWslExecutablePath: vi.fn(() => 'C:\\Windows\\System32\\wsl.exe')
}))

vi.mock('../pty/bundled-guest-tree-kill', () => ({
  resolveBundledGuestTreeKillArtifact: vi.fn((platform: string) => ({
    path: `C:\\Orca\\guest-tree-kill\\${platform}\\orca-guest-tree-kill`,
    sha256: 'a'.repeat(64),
    bytes: Buffer.from('x64')
  }))
}))

const artifacts = {
  x64: { path: 'C:\\Orca\\linux-x64\\helper', sha256: 'a'.repeat(64), bytes: Buffer.from('x64') },
  arm64: {
    path: 'C:\\Orca\\linux-arm64\\helper',
    sha256: 'b'.repeat(64),
    bytes: Buffer.from('arm64')
  }
}

let platformDescriptor: PropertyDescriptor | undefined
const success: ProcessResult = {
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false
}
const running = { ...success, stdout: 'Ubuntu\r\n' }
const args = { distro: 'Ubuntu', treeId: '00112233-4455-6677-8899-aabbccddeeff' }

beforeEach(() => {
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.mocked(resolveWslExecutablePath).mockReturnValue('C:\\Windows\\System32\\wsl.exe')
  vi.mocked(resolveBundledGuestTreeKillArtifact).mockImplementation((platform) => ({
    path: artifacts[platform === 'linux-x64' ? 'x64' : 'arm64'].path,
    sha256: 'a'.repeat(64),
    bytes: Buffer.from('x64')
  }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('buildWslGuestTreeKillArgs', () => {
  it('uses a fixed isolated bootstrap as root and passes inputs positionally', () => {
    const token = 'worktree@@a1b2c3d4'
    const argv = buildWslGuestTreeKillArgs('Ubuntu', token, artifacts, 3_000)
    expect(argv.slice(0, 11)).toEqual([
      '--user',
      'root',
      '-d',
      'Ubuntu',
      '--exec',
      '/usr/bin/env',
      '-i',
      'PATH=/usr/bin:/bin',
      'LC_ALL=C',
      '/bin/sh',
      '-c'
    ])
    expect(argv.at(-2)).toBe(token)
    expect(argv.slice(0, -2).join('\n')).not.toContain(token)
    const script = argv[11]
    expect(script).toContain('sha256sum')
    expect(script).toContain('mktemp -d /tmp/')
    expect(script).toContain('uname -m')
    expect(script).not.toContain('python')
    expect(argv.slice(-4, -2)).toEqual([artifacts.x64.sha256, artifacts.arm64.sha256])
  })
})

describe('runWslGuestTreeKill', () => {
  it('confirms the running distro before using the remaining shared deadline', async () => {
    const run = vi
      .fn<WslGuestTreeKillRunner>()
      .mockResolvedValueOnce(running)
      .mockResolvedValue(success)
    await expect(runWslGuestTreeKill({ ...args, run })).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0]?.[0].args).toEqual(['--list', '--running', '--quiet'])
    const spec = run.mock.calls[1]?.[0]
    expect(spec?.program).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(spec?.input).toBe('eDY0\neDY0\n')
    expect(spec?.timeoutMs).toBeLessThanOrEqual(WSL_GUEST_TREE_KILL_TIMEOUT_MS)
    expect(Number(spec?.args?.at(-1))).toBeLessThan(Number(spec?.timeoutMs))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('does not import ambient loader or interpreter code into the root guest', async () => {
    vi.stubEnv('WSLENV', 'LD_PRELOAD/u:PYTHONPATH/u')
    vi.stubEnv('LD_PRELOAD', '/tmp/caller.so')
    vi.stubEnv('PYTHONPATH', '/tmp/caller')
    const run = vi
      .fn<WslGuestTreeKillRunner>()
      .mockResolvedValueOnce(running)
      .mockResolvedValue(success)
    await runWslGuestTreeKill({ ...args, run })
    const env = run.mock.calls[1]?.[0].env
    expect(env?.WSLENV).toBe('')
    expect(env?.LD_PRELOAD).toBeUndefined()
    expect(env?.PYTHONPATH).toBeUndefined()
  })

  it('does not restart a stopped distro, including after a successful earlier cleanup', async () => {
    const run = vi
      .fn<WslGuestTreeKillRunner>()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(success)
      .mockResolvedValue(success)
    await runWslGuestTreeKill({ ...args, run })
    await runWslGuestTreeKill({ ...args, run })
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[2]?.[0].args).toEqual(['--list', '--running', '--quiet'])
  })

  it('does not reuse a cached running list after discovery fails', async () => {
    const run = vi
      .fn<WslGuestTreeKillRunner>()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(success)
      .mockRejectedValue(new Error('unavailable'))
    await runWslGuestTreeKill({ ...args, run })
    await runWslGuestTreeKill({ ...args, run })
    await runWslGuestTreeKill({ ...args, run })
    expect(run).toHaveBeenCalledTimes(4)
    expect(console.warn).toHaveBeenCalled()
  })

  it.each([
    { ...success, code: 1 },
    { ...success, timedOut: true },
    { ...success, outputTruncated: true }
  ])('never launches the guest after an unconfirmed list: %o', async (result) => {
    const run = vi.fn<WslGuestTreeKillRunner>().mockResolvedValue(result)
    await runWslGuestTreeKill({ ...args, run })
    expect(run).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalled()
  })

  it('handles case-insensitive UTF-16 running names through the existing parser', async () => {
    const run = vi
      .fn<WslGuestTreeKillRunner>()
      .mockResolvedValueOnce({ ...success, stdout: 'u\0b\0u\0n\0t\0u\0\r\0\n\0' })
      .mockResolvedValue(success)
    await runWslGuestTreeKill({ ...args, run })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('bounds a hung probe and never launches the guest on late settlement', async () => {
    vi.useFakeTimers()
    let resolve: (value: ProcessResult) => void = () => {}
    const run = vi.fn<WslGuestTreeKillRunner>().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const cleanup = runWslGuestTreeKill({ ...args, run })
    await vi.advanceTimersByTimeAsync(1_000)
    await cleanup
    expect(run.mock.calls[0]?.[0].signal?.aborted).toBe(true)
    resolve(running)
    await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()
  })

  it('bounds a hung guest without waiting for the process runner exit grace', async () => {
    vi.useFakeTimers()
    const run = vi
      .fn<WslGuestTreeKillRunner>()
      .mockResolvedValueOnce(running)
      .mockImplementation(() => new Promise(() => {}))
    const cleanup = runWslGuestTreeKill({ ...args, run })
    await vi.advanceTimersByTimeAsync(WSL_GUEST_TREE_KILL_TIMEOUT_MS)
    await cleanup
    expect(run.mock.calls[1]?.[0].signal?.aborted).toBe(true)
    expect(console.warn).toHaveBeenCalled()
  })

  it.each([2, 3, 127])(
    'reports unavailable capability / incomplete scan (exit %i)',
    async (code) => {
      const run = vi
        .fn<WslGuestTreeKillRunner>()
        .mockResolvedValueOnce(running)
        .mockResolvedValue({ ...success, code })
      await runWslGuestTreeKill({ ...args, run })
      expect(console.warn).toHaveBeenCalledWith('[daemon] WSL guest cleanup unverifiable', {
        code,
        timedOut: false,
        reason:
          code === 3
            ? 'guest helper or kernel capability unavailable'
            : 'guest helper unavailable or incomplete'
      })
    }
  )

  it.each([undefined, '', 'sess\n@@evil', 'x'.repeat(513), 'legacy-session-id'])(
    'skips an unusable marker %p',
    async (treeId) => {
      const run = vi.fn<WslGuestTreeKillRunner>()
      await runWslGuestTreeKill({ distro: 'Ubuntu', treeId, run })
      expect(run).not.toHaveBeenCalled()
    }
  )

  it('does not extend the deadline when artifact validation has already consumed it', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(4_001)
    const run = vi.fn<WslGuestTreeKillRunner>()
    await runWslGuestTreeKill({ ...args, run })
    expect(run).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
  })

  it('does not enter the guest when either bundled artifact fails verification', async () => {
    vi.mocked(resolveBundledGuestTreeKillArtifact).mockReturnValueOnce(null)
    const run = vi.fn<WslGuestTreeKillRunner>()
    await runWslGuestTreeKill({ ...args, run })
    expect(run).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
  })

  it('rejects a bare wsl.exe fallback before privileged execution', async () => {
    vi.mocked(resolveWslExecutablePath).mockReturnValue('wsl.exe')
    const run = vi.fn<WslGuestTreeKillRunner>()
    await runWslGuestTreeKill({ ...args, run })
    expect(run).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
  })

  it('skips missing distro and off-platform calls', async () => {
    const run = vi.fn<WslGuestTreeKillRunner>()
    await runWslGuestTreeKill({ ...args, distro: '', run })
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    await runWslGuestTreeKill({ ...args, run })
    expect(run).not.toHaveBeenCalled()
  })
})
