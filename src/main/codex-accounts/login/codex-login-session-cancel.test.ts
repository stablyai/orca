import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

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

import { runCodexLoginSession } from './codex-login-session'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../../shared/agent-accounts/codex/codex-auth-errors'

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\managed-home'

describe('runCodexLoginSession cancellation', () => {
  it('rejects only after the login tree kill settles', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true
    })
    const spawn = vi.fn(() => child)
    let finishKill: () => void = () => {}
    const killProcessTree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishKill = resolve
        })
    )
    let cancel: () => boolean = () => false
    let outcome: 'pending' | 'rejected' = 'pending'
    const done = runCodexLoginSession(WSL_HOME, {
      wslCommand: 'wsl.exe',
      spawn,
      killProcessTree,
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
    expect(killProcessTree).toHaveBeenCalledOnce()
    expect(outcome).toBe('pending')

    finishKill()
    await expect(done).rejects.toThrow(CODEX_LOGIN_CANCELLED_MESSAGE)
  })
})
