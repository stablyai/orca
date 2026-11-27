import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../wsl/execution/wsl-runner', () => ({
  runWslProcess: vi.fn(async () => ({
    environmentResolved: true,
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false
  }))
}))
vi.mock('../../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('../../providers/shell-launch/windows/windows-interactive-login-spawn', () => ({
  buildWindowsHostInteractiveLoginSpawn: () => ({
    command: 'codex',
    args: ['login'],
    stdio: 'ignore',
    cleanup: async () => {},
    getTerminationPid: () => null,
    readExitCode: async () => null
  })
}))

import { runCodexLoginSession } from './codex-login-session'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../../shared/agent-accounts/codex/codex-auth-errors'

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\managed-home'
const hostPlatform = process.platform

const loginChild = () =>
  Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true
  })

function pendingKill(): { killProcessTree: () => Promise<void>; finish: () => void } {
  let finish: () => void = () => {}
  const killProcessTree = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  return { killProcessTree, finish: () => finish() }
}

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
})

describe('runCodexLoginSession cancellation', () => {
  it('rejects only after the login tree kill settles', async () => {
    const child = loginChild()
    const spawn = vi.fn(() => child)
    const kill = pendingKill()
    let cancel: () => boolean = () => false
    let outcome: 'pending' | 'rejected' = 'pending'
    const done = runCodexLoginSession(WSL_HOME, {
      wslCommand: 'wsl.exe',
      spawn,
      killProcessTree: kill.killProcessTree,
      setCancel: (next) => {
        cancel = next
      },
      onAuthUrl: vi.fn()
    }).catch((error: Error) => {
      outcome = 'rejected'
      throw error
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())

    expect(cancel()).toBe(true)
    // A macrotask yield drains every microtask, so a rejection not gated on the kill shows here.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(kill.killProcessTree).toHaveBeenCalledOnce()
    expect(outcome).toBe('pending')

    kill.finish()
    await expect(done).rejects.toThrow(CODEX_LOGIN_CANCELLED_MESSAGE)
  })

  it('never offers the link of a WSL login cancelled while its tree kill runs', async () => {
    const child = loginChild()
    const kill = pendingKill()
    const onAuthUrl = vi.fn()
    const openWslAuthUrl = vi.fn()
    let cancel: () => boolean = () => false
    const done = runCodexLoginSession(WSL_HOME, {
      wslCommand: 'wsl.exe',
      spawn: () => child,
      killProcessTree: kill.killProcessTree,
      setCancel: (next) => {
        cancel = next
      },
      onAuthUrl,
      openWslAuthUrl
    })
    await vi.waitFor(() => expect(child.stderr.listenerCount('data')).toBe(1))

    expect(cancel()).toBe(true)
    child.stderr.write(
      'Navigate to this URL to authenticate: https://auth.openai.com/oauth/authorize?state=1 \n'
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onAuthUrl).not.toHaveBeenCalled()
    expect(openWslAuthUrl).not.toHaveBeenCalled()
    kill.finish()
    await expect(done).rejects.toThrow(CODEX_LOGIN_CANCELLED_MESSAGE)
  })

  it('finishes a Windows login only after its post-sign-in tree kill', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.useFakeTimers()
    const home = mkdtempSync(join(tmpdir(), 'codex-login-home-'))
    try {
      const child = loginChild()
      const kill = pendingKill()
      let outcome: 'pending' | 'resolved' = 'pending'
      const done = runCodexLoginSession(home, {
        wslCommand: 'wsl.exe',
        spawn: () => child,
        killProcessTree: kill.killProcessTree,
        setCancel: () => {},
        onAuthUrl: vi.fn()
      }).then(() => {
        outcome = 'resolved'
      })

      writeFileSync(join(home, 'auth.json'), '{"tokens":{}}')
      await vi.advanceTimersByTimeAsync(6_000)
      expect(kill.killProcessTree).toHaveBeenCalledOnce()
      child.emit('close', 1)
      await vi.advanceTimersByTimeAsync(0)
      expect(outcome).toBe('pending')

      kill.finish()
      await done
      expect(outcome).toBe('resolved')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
