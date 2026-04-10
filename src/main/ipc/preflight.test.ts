import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, execFileAsyncMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  execFileAsyncMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('util', async () => {
  const actual = await vi.importActual('util')
  return {
    ...actual,
    promisify: vi.fn(() => execFileAsyncMock)
  }
})

import { _resetPreflightCache, registerPreflightHandlers, runPreflightCheck } from './preflight'

type HandlerMap = Record<string, (_event?: unknown, args?: { force?: boolean }) => Promise<unknown>>

describe('preflight', () => {
  const handlers: HandlerMap = {}

  beforeEach(() => {
    handleMock.mockReset()
    execFileAsyncMock.mockReset()
    _resetPreflightCache()

    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
  })

  it('marks gh as authenticated when gh auth status exits successfully', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })

    const status = await runPreflightCheck()

    expect(status).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true }
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(3, 'gh', ['auth', 'status'], {
      encoding: 'utf-8'
    })
  })

  it('treats gh as unauthenticated when gh auth status fails without auth markers', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })

    const status = await runPreflightCheck()

    expect(status.gh).toEqual({ installed: true, authenticated: false })
  })

  it('keeps older gh stderr success output from showing a false auth warning', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockRejectedValueOnce({ stderr: 'Logged in to github.com account octocat\n' })

    const status = await runPreflightCheck()

    expect(status.gh).toEqual({ installed: true, authenticated: true })
  })

  it('re-runs the probe when forced so updated gh auth state is visible without relaunch', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })

    const firstStatus = await runPreflightCheck()
    const refreshedStatus = await runPreflightCheck(true)

    expect(firstStatus.gh).toEqual({ installed: true, authenticated: false })
    expect(refreshedStatus.gh).toEqual({ installed: true, authenticated: true })
    expect(execFileAsyncMock).toHaveBeenCalledTimes(6)
  })

  it('registers the preflight handler', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n' })

    registerPreflightHandlers()

    const status = await handlers['preflight:check']()

    expect(status).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true }
    })
  })

  it('lets the IPC handler bypass the session cache when forced', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })
      .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
      .mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })

    registerPreflightHandlers()

    const firstStatus = await handlers['preflight:check']()
    const refreshedStatus = await handlers['preflight:check'](null, { force: true })

    expect(firstStatus).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: false }
    })
    expect(refreshedStatus).toEqual({
      git: { installed: true },
      gh: { installed: true, authenticated: true }
    })
  })
})
