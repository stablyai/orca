import { afterEach, describe, expect, it, vi } from 'vitest'
import { bunRelayPtyModule } from './relay-pty-runtime'

const { terminal, spawn } = vi.hoisted(() => {
  const terminal = { destroy: vi.fn(), waitForSpawn: vi.fn(async () => {}) }
  return { terminal, spawn: vi.fn(() => terminal) }
})
vi.mock('../main/daemon/pty-subprocess/bun-pty-process', () => ({ spawnBunPty: spawn }))

const options = { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/workspace', env: {} }
afterEach(() => vi.resetAllMocks())

describe('relay Bun terminal admission', () => {
  it('waits for the shell receipt before returning ownership', async () => {
    let confirm: (() => void) | undefined
    terminal.waitForSpawn.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve
        })
    )
    let admitted = false
    const result = Promise.resolve(bunRelayPtyModule.spawn('/shell', ['-l'], options)).then(
      (pty) => {
        admitted = true
        return pty
      }
    )
    await Promise.resolve()
    expect(admitted).toBe(false)
    confirm?.()
    expect(await result).toBe(terminal)
    expect(spawn).toHaveBeenCalledWith({
      file: '/shell',
      args: ['-l'],
      cwd: '/workspace',
      cols: 80,
      rows: 24,
      env: { TERM: 'xterm-256color' }
    })
  })

  it('destroys the unowned shell when its receipt fails', async () => {
    const error = new Error('shell refused')
    terminal.waitForSpawn.mockRejectedValueOnce(error)
    await expect(bunRelayPtyModule.spawn('/shell', [], options)).rejects.toBe(error)
    expect(terminal.destroy).toHaveBeenCalledOnce()
  })

  it('does not spawn after cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(bunRelayPtyModule.spawn('/shell', [], options, controller.signal)).rejects.toThrow(
      'cancelled'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('cleans up a shell when cancellation wins against its pending receipt', async () => {
    terminal.waitForSpawn.mockImplementationOnce(() => new Promise(() => {}))
    const controller = new AbortController()
    const result = bunRelayPtyModule.spawn('/shell', [], options, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(result).rejects.toThrow('cancelled')
    expect(terminal.destroy).toHaveBeenCalledOnce()
  })
})
