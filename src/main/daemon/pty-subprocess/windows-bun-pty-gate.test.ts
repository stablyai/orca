import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../../shared/child-process/run-process'
import { runWindowsBunPtyGate, type WindowsBunPtyGateRequest } from './windows-bun-pty-gate'

const request: WindowsBunPtyGateRequest = {
  file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  args: ['-NoLogo', '-NoExit', '-Command', 'A'.repeat(16000)],
  cwd: 'C:\\work',
  gatePath: 'gate',
  shellPidPath: 'shell.pid',
  runtimeOptions: {}
}

describe('Windows Bun PTY job gate worker', () => {
  it('does not spawn before assignment and propagates the child exit code', async () => {
    let release!: () => void
    const waitForGate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const child = Object.assign(new EventEmitter(), { pid: 1234 })
    const reportShellPid = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture exposes only the child events and pid the gate consumes.
    const spawn = vi.fn(() => child as ReturnType<typeof spawnProcess>)
    const result = runWindowsBunPtyGate(request, {
      waitForGate,
      spawn,
      reportShellPid,
      env: { TERM: 'xterm-256color' }
    })
    await Promise.resolve()
    expect(spawn).not.toHaveBeenCalled()
    release()
    await Promise.resolve()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        program: request.file,
        args: request.args,
        cwd: request.cwd,
        stdio: 'inherit'
      })
    )
    expect(reportShellPid).not.toHaveBeenCalled()
    child.emit('spawn')
    expect(reportShellPid).toHaveBeenCalledWith(1234)
    child.emit('exit', 17)
    await expect(result).resolves.toBe(17)
  })

  it('never starts a child after a failed job gate', async () => {
    const spawn = vi.fn()
    await expect(
      runWindowsBunPtyGate(request, {
        waitForGate: async () => {
          throw new Error('gate missing')
        },
        reportSpawnError: vi.fn(),
        spawn
      })
    ).rejects.toThrow('gate missing')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps supervising the shell when its identity receipt cannot be published', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 1234 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reportSpawnError = vi.fn()
    const result = runWindowsBunPtyGate(request, {
      waitForGate: async () => {},
      reportSpawnError,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture exposes only the child events and pid consumed by the gate.
      spawn: () => child as ReturnType<typeof spawnProcess>,
      reportShellPid() {
        throw new Error('receipt denied')
      }
    })
    await Promise.resolve()
    child.emit('spawn')
    expect(warn).toHaveBeenCalledOnce()
    child.emit('exit', 17)
    await expect(result).resolves.toBe(17)
    expect(reportSpawnError).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports a child spawn error instead of a successful wrapper exit', async () => {
    const child = new EventEmitter()
    const reportSpawnError = vi.fn()
    const result = runWindowsBunPtyGate(request, {
      waitForGate: async () => {},
      reportSpawnError,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture exposes the error/exit events the gate consumes.
      spawn: () => child as ReturnType<typeof spawnProcess>
    })
    await Promise.resolve()
    child.emit('error', new Error('spawn denied'))
    await expect(result).rejects.toThrow('spawn denied')
    expect(reportSpawnError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'spawn denied' })
    )
  })

  it('reports synchronous native spawn rejection without requiring a child event', async () => {
    const reportSpawnError = vi.fn()
    await expect(
      runWindowsBunPtyGate(request, {
        waitForGate: async () => {},
        spawn: () => {
          throw new Error('invalid executable')
        },
        reportSpawnError
      })
    ).rejects.toThrow('invalid executable')
    expect(reportSpawnError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'invalid executable' })
    )
  })
})
