import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../../shared/child-process/run-process'
import { runWindowsBunPtyGate, type WindowsBunPtyGateRequest } from './windows-bun-pty-gate'

const request: WindowsBunPtyGateRequest = {
  file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  args: ['-NoLogo', '-NoExit', '-EncodedCommand', 'A'.repeat(16000)],
  cwd: 'C:\\work',
  gatePath: 'gate',
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
    const child = new EventEmitter()
    const spawn = vi.fn(() => child as ReturnType<typeof spawnProcess>)
    const result = runWindowsBunPtyGate(request, {
      waitForGate,
      spawn,
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
        spawn
      })
    ).rejects.toThrow('gate missing')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a child spawn error instead of a successful wrapper exit', async () => {
    const child = new EventEmitter()
    const result = runWindowsBunPtyGate(request, {
      waitForGate: async () => {},
      spawn: () => child as ReturnType<typeof spawnProcess>
    })
    await Promise.resolve()
    child.emit('error', new Error('spawn denied'))
    await expect(result).rejects.toThrow('spawn denied')
  })
})
