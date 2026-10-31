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
import {
  peekWslGitReadEnvironment,
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests
} from '../wsl-git-read-environment'
import { _resetGitAdmissionForTests } from './git-subprocess-admission'

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

describe('git reads over wsl.exe when the WSL service fails', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })
  afterEach(() => {
    _resetGitAdmissionForTests()
  })

  const TRANSIENT = 'Catastrophic failure \r\nError code: Wsl/Service/E_UNEXPECTED\r\n'

  function answerWith(results: ({ fail: string } | { stdout: string })[]): void {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      const child = Object.assign(new EventEmitter(), { pid: 4321, kill: () => {} })
      const next = results.shift() ?? { stdout: '' }
      queueMicrotask(() =>
        'fail' in next
          ? callback?.(hostFailure(next.fail), next.fail, '')
          : callback?.(null, next.stdout, '')
      )
      return child
    })
  }

  it('fails a direct read on a WSL service error without the login-shell fallback', async () => {
    await withPlatform('win32', async () => {
      const environment = { gitPath: '/usr/bin/git', home: '/home/u', path: '/usr/bin:/bin' }
      seedWslGitReadEnvironmentForTests('Ubuntu', environment)
      answerWith([{ fail: TRANSIENT }, { stdout: 'login-shell fallback' }])
      const failure = await gitExecFileAsync(['status', '--short'], {
        cwd: String.raw`C:\repo`,
        preferWslDirectGit: true,
        wslDistro: 'Ubuntu'
      }).catch((error: unknown) => error)
      expect(String(failure)).toContain('Wsl/Service/E_UNEXPECTED')
      // One direct launch and no login-shell fallback, so the fast path stays on.
      expect(execFileMock).toHaveBeenCalledOnce()
      expect(peekWslGitReadEnvironment('Ubuntu')).toEqual(environment)
    }).finally(resetWslGitReadEnvironmentForTests)
  })
})
