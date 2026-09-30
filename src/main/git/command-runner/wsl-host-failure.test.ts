import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))
vi.mock('../../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: (span: unknown) => unknown) =>
    run({ setAttribute: () => {} })
}))
vi.mock('../../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { gitExecFileAsync } from '../runner'
import { _resetGitAdmissionForTests } from './git-subprocess-admission'
import { nonInteractiveGitEnv } from './git-process-env'
import { annotateWslHostFailure, readWslHostFailureDiagnostic } from './wsl-host-failure'
import type { ResolvedCommand } from './wsl-command-resolution'

const WSL_COMMAND: ResolvedCommand = {
  binary: 'wsl.exe',
  args: ['-d', 'kali-linux', '--exec', 'sh', '-lc', 'git worktree list'],
  cwd: 'C:\\Users\\paulius',
  wsl: { distro: 'kali-linux', linuxPath: '/home/paulius/bugbounty' },
  wslMode: 'login-shell'
}

const WSL_DIAGNOSTIC =
  'There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n'

/** wsl.exe without WSL_UTF8 writes its own diagnostic as UTF-16LE, which reaches Node as NUL-riddled text. */
function asUtf16Mojibake(text: string): string {
  return [...text].map((character) => `${character}\u0000`).join('')
}

function hostFailure(stdout: string): Error {
  return Object.assign(new Error('Command failed: wsl.exe -d kali-linux --exec sh -lc ...'), {
    code: 4294967295,
    stdout,
    stderr: ''
  })
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('wsl.exe host failure classification', () => {
  it('reads the diagnostic wsl.exe left on stdout, including UTF-16 output', () => {
    expect(readWslHostFailureDiagnostic(hostFailure(WSL_DIAGNOSTIC), WSL_COMMAND)).toContain(
      'Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
    )
    expect(
      readWslHostFailureDiagnostic(hostFailure(asUtf16Mojibake(WSL_DIAGNOSTIC)), WSL_COMMAND)
    ).toContain('Wsl/Service/WSL_E_DISTRO_NOT_FOUND')
  })

  it('leaves a guest failure and a non-WSL command alone', () => {
    const guestFailure = Object.assign(new Error('Command failed'), {
      code: 1,
      stdout: '',
      stderr: 'fatal: not a git repository\n'
    })
    expect(readWslHostFailureDiagnostic(guestFailure, WSL_COMMAND)).toBeNull()
    // Same exit code, but wsl.exe was never involved.
    expect(
      readWslHostFailureDiagnostic(hostFailure(WSL_DIAGNOSTIC), {
        binary: 'git',
        args: ['status'],
        cwd: '/repo',
        wsl: null,
        wslMode: null
      })
    ).toBeNull()
  })

  it('moves the diagnostic into the message the span records', () => {
    const error = annotateWslHostFailure(hostFailure(WSL_DIAGNOSTIC), WSL_COMMAND) as Error & {
      wslHostFailure?: boolean
      wslDistro?: string
      code?: number
    }
    expect(error.message).toContain('Wsl/Service/WSL_E_DISTRO_NOT_FOUND')
    expect(error.message).toContain('kali-linux')
    expect(error.wslHostFailure).toBe(true)
    expect(error.wslDistro).toBe('kali-linux')
    // The original failure detail must survive for callers that classify on it.
    expect(error.code).toBe(4294967295)
    expect(error.message).toContain('Command failed: wsl.exe')
  })
})

describe('WSL-routed git subprocess', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  afterEach(() => {
    _resetGitAdmissionForTests()
  })

  it('sets WSL_UTF8 so wsl.exe explains itself in UTF-8', () => {
    expect(nonInteractiveGitEnv({}, 'win32').WSL_UTF8).toBe('1')
    expect(nonInteractiveGitEnv({}, 'darwin').WSL_UTF8).toBeUndefined()
  })

  it('reports a dead distro instead of an empty git error', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => void }
      child.pid = 4321
      child.kill = () => {}
      queueMicrotask(() =>
        callback?.(
          hostFailure(asUtf16Mojibake(WSL_DIAGNOSTIC)),
          asUtf16Mojibake(WSL_DIAGNOSTIC),
          ''
        )
      )
      return child
    })

    const failure = await withPlatform('win32', () =>
      gitExecFileAsync(['worktree', 'list', '--porcelain', '-z'], {
        cwd: '\\\\wsl.localhost\\kali-linux\\home\\paulius\\bugbounty'
      }).then(
        () => null,
        (error: unknown) => error as Error
      )
    )

    expect(failure?.message).toContain('Wsl/Service/WSL_E_DISTRO_NOT_FOUND')
    expect(execFileMock.mock.calls.at(-1)?.[2]?.env?.WSL_UTF8).toBe('1')
  })
})
