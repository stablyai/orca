import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { electron, prepare, state } = vi.hoisted(() => ({
  electron: {
    isPackaged: true,
    quit: vi.fn(),
    exit: vi.fn(),
    relaunch: vi.fn()
  },
  prepare: vi.fn(),
  state: { isQuitting: false }
}))

vi.mock('electron', () => ({ app: Object.assign(new EventEmitter(), electron) }))
vi.mock('../main-process-state', () => ({ mainProcessState: state }))
vi.mock('../../updater/linux-package/appimage-runtime-identity', () => ({
  isEphemeralAppImageRuntime: () => electron.isPackaged
}))
vi.mock('./appimage-relaunch', () => ({ prepareAppImageRelaunch: prepare }))

import { app } from 'electron'

function launcher() {
  return { commit: vi.fn(async () => {}), cancel: vi.fn() }
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  app.removeAllListeners()
  state.isQuitting = false
  electron.isPackaged = true
  electron.quit.mockImplementation(() => app.emit('before-quit', { defaultPrevented: false }))
})

describe('process relaunch', () => {
  it('discards a vetoed graceful restart before an ordinary quit or a retry', async () => {
    const lifecycle = await import('./process-relaunch')
    const first = launcher()
    const second = launcher()
    prepare.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const restart = await lifecycle.prepareProcessRelaunch({ args: ['--first'] })
    const quitting = restart.quit()
    lifecycle.cancelProcessRelaunch()
    await expect(quitting).rejects.toThrow('Orca restart was canceled.')
    await lifecycle.commitGracefulProcessRelaunch()
    expect(first.commit).not.toHaveBeenCalled()

    const retry = await lifecycle.prepareProcessRelaunch({ args: ['--retry', 'new file'] })
    expect(prepare).toHaveBeenLastCalledWith(['--retry', 'new file'], expect.any(AbortSignal))
    const retryQuit = retry.quit()
    await lifecycle.commitGracefulProcessRelaunch()
    await lifecycle.commitGracefulProcessRelaunch()
    await retryQuit
    expect(second.commit).toHaveBeenCalledTimes(1)
    expect(electron.relaunch).not.toHaveBeenCalled()
  })

  it('does not arm an explicit executable during a vetoed before-quit', async () => {
    const lifecycle = await import('./process-relaunch')
    const options = { execPath: '/opt/replacement', args: ['--custom'] }
    app.on('before-quit', (event: { defaultPrevented: boolean }) => {
      event.defaultPrevented = true
    })
    const restart = await lifecycle.prepareProcessRelaunch(options)
    await expect(restart.quit()).rejects.toThrow('Orca restart was canceled.')
    await lifecycle.commitGracefulProcessRelaunch()
    expect(electron.relaunch).not.toHaveBeenCalled()
    const retry = await lifecycle.prepareProcessRelaunch(options)
    await retry.exit(0)
    expect(electron.relaunch).toHaveBeenCalledWith(options)
    expect(electron.exit).toHaveBeenCalledWith(0)
  })

  it('rejects concurrent AppImage, default and explicit requests while the first is preparing', async () => {
    const lifecycle = await import('./process-relaunch')
    const first = launcher()
    const pending = Promise.withResolvers<ReturnType<typeof launcher>>()
    prepare.mockReturnValueOnce(pending.promise)
    const request = lifecycle.prepareProcessRelaunch({ args: ['--first'] })
    await expect(lifecycle.prepareProcessRelaunch()).rejects.toThrow('already restarting')
    await expect(lifecycle.prepareProcessRelaunch({ execPath: '/other' })).rejects.toThrow(
      'already restarting'
    )
    pending.resolve(first)
    const restart = await request
    const quitting = restart.quit()
    await expect(lifecycle.prepareProcessRelaunch()).rejects.toThrow('already restarting')
    await lifecycle.commitGracefulProcessRelaunch()
    await quitting
    expect(first.commit).toHaveBeenCalledTimes(1)
    expect(electron.relaunch).not.toHaveBeenCalled()
  })

  it('discards an asynchronous preparation superseded by an ordinary quit', async () => {
    const lifecycle = await import('./process-relaunch')
    const stale = launcher()
    const pending = Promise.withResolvers<ReturnType<typeof launcher>>()
    prepare.mockReturnValueOnce(pending.promise)
    const request = lifecycle.prepareProcessRelaunch()
    lifecycle.cancelProcessRelaunchPreparation()
    pending.resolve(stale)
    await expect(request).rejects.toThrow('Orca restart was canceled.')
    await lifecycle.commitGracefulProcessRelaunch()
    expect(stale.commit).not.toHaveBeenCalled()
    expect(electron.relaunch).not.toHaveBeenCalled()
  })

  it('keeps the app open after failed preparation and can subsequently use a direct exit', async () => {
    const lifecycle = await import('./process-relaunch')
    const replacement = launcher()
    prepare
      .mockRejectedValueOnce(new Error('Original AppImage is missing.'))
      .mockResolvedValueOnce(replacement)
    await expect(lifecycle.prepareProcessRelaunch()).rejects.toThrow(
      'Original AppImage is missing.'
    )
    expect(electron.quit).not.toHaveBeenCalled()
    expect(electron.exit).not.toHaveBeenCalled()
    expect(electron.relaunch).not.toHaveBeenCalled()
    const restart = await lifecycle.prepareProcessRelaunch({ args: ['--recovery'] })
    await restart.exit(1)
    expect(replacement.commit).toHaveBeenCalledTimes(1)
    expect(electron.exit).toHaveBeenCalledWith(1)
  })
})
