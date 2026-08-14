import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SERVE_UPDATE_HANDOFF_PATH_ENV,
  getServeUpdateHandoffPath,
  parseServeSupervisorMessage,
  parseServeUpdateHandoffState
} from '../shared/serve-update-handoff'
import { SERVE_SUPERVISOR_ENV, SERVE_SUPERVISOR_STOP_EXIT_CODE } from '../shared/serve-supervision'

const { appMock, getCanonicalUserDataPathMock } = vi.hoisted(() => ({
  appMock: {
    exit: vi.fn(),
    getVersion: vi.fn(() => '1.0.51'),
    isReady: vi.fn(() => true),
    quit: vi.fn()
  },
  getCanonicalUserDataPathMock: vi.fn()
}))

vi.mock('electron', () => ({ app: appMock }))
vi.mock('./persistence', () => ({ getCanonicalUserDataPath: getCanonicalUserDataPathMock }))

describe('serve update handoff', () => {
  let root: string

  beforeEach(() => {
    vi.resetModules()
    appMock.exit.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.isReady.mockReturnValue(true)
    appMock.quit.mockReset()
    root = mkdtempSync(join(tmpdir(), 'orca-serve-handoff-'))
    getCanonicalUserDataPathMock.mockReturnValue(root)
    process.env[SERVE_UPDATE_HANDOFF_PATH_ENV] = getServeUpdateHandoffPath(root)
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env[SERVE_UPDATE_HANDOFF_PATH_ENV]
    delete process.env[SERVE_SUPERVISOR_ENV]
    rmSync(root, { recursive: true, force: true })
  })

  it.runIf(process.platform === 'darwin')(
    'persists install intent and a later deterministic failure for the serving pid',
    async () => {
      const {
        failServeUpdateHandoff,
        getServeUpdateHandoffFailure,
        hasServeUpdateSupervisor,
        requestServeUpdateHandoff
      } = await import('./serve-update-handoff')

      expect(hasServeUpdateSupervisor()).toBe(true)
      expect(requestServeUpdateHandoff('1.0.61')).toBe(true)
      expect(readState(root)).toEqual({
        schemaVersion: 1,
        phase: 'install-requested',
        fromVersion: '1.0.51',
        targetVersion: '1.0.61',
        servingPid: process.pid
      })

      failServeUpdateHandoff('native updater rejected the request')

      expect(readState(root)).toEqual({
        schemaVersion: 1,
        phase: 'failed',
        fromVersion: '1.0.51',
        targetVersion: '1.0.61',
        servingPid: process.pid,
        reason: 'native updater rejected the request'
      })
      expect(getServeUpdateHandoffFailure()).toBe('native updater rejected the request')

      appMock.getVersion.mockReturnValue('1.0.61')
      expect(getServeUpdateHandoffFailure()).toBeNull()
      expect(existsSync(getServeUpdateHandoffPath(root))).toBe(false)
    }
  )

  it('rejects a handoff path outside the canonical user-data directory', async () => {
    process.env[SERVE_UPDATE_HANDOFF_PATH_ENV] = join(root, '..', 'untrusted.json')
    const { hasServeUpdateSupervisor, requestServeUpdateHandoff } =
      await import('./serve-update-handoff')

    expect(hasServeUpdateSupervisor()).toBe(false)
    expect(requestServeUpdateHandoff('1.0.61')).toBe(false)
  })

  it.each([
    { websocket: ['ready'], runtime: 'ready', graph: 'ready' },
    { websocket: 'ready', runtime: ['ready'], graph: 'ready' },
    { websocket: 'ready', runtime: 'ready', graph: ['ready'] }
  ])('rejects non-string supervisor health values', (health) => {
    expect(
      parseServeSupervisorMessage({
        type: 'orca:serve-ready',
        version: '1.4.181',
        runtimeId: 'runtime-ready',
        health
      })
    ).toBeNull()
  })

  it.runIf(process.platform === 'darwin')(
    'quits a supervised serve child when its CLI parent is lost',
    async () => {
      const parent = new EventEmitter()
      const { installServeSupervisorDisconnectQuit } = await import('./serve-update-handoff')

      const removeListener = installServeSupervisorDisconnectQuit(true, parent)
      parent.emit('disconnect')

      expect(appMock.quit).toHaveBeenCalledOnce()
      removeListener()
    }
  )

  it('quits a supervised serve child on every platform when its CLI parent is lost', async () => {
    vi.useFakeTimers()
    const parent = new EventEmitter()
    process.env[SERVE_SUPERVISOR_ENV] = '1'
    const { installServeSupervisorDisconnectQuit, SERVE_SUPERVISOR_EXIT_FALLBACK_MS } =
      await import('./serve-update-handoff')

    const removeListener = installServeSupervisorDisconnectQuit(true, parent)
    parent.emit('disconnect')

    expect(appMock.quit).toHaveBeenCalledOnce()
    expect(appMock.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SERVE_SUPERVISOR_EXIT_FALLBACK_MS)
    expect(appMock.exit).toHaveBeenCalledWith(SERVE_SUPERVISOR_STOP_EXIT_CODE)
    removeListener()
  })

  it('exits immediately when the foreground supervisor disconnected before startup wiring', async () => {
    const parent = Object.assign(new EventEmitter(), { connected: false })
    process.env[SERVE_SUPERVISOR_ENV] = '1'
    appMock.isReady.mockReturnValue(false)
    const { installServeSupervisorDisconnectQuit } = await import('./serve-update-handoff')

    const removeListener = installServeSupervisorDisconnectQuit(true, parent)

    expect(appMock.exit).toHaveBeenCalledWith(SERVE_SUPERVISOR_STOP_EXIT_CODE)
    expect(appMock.quit).not.toHaveBeenCalled()
    expect(parent.listenerCount('disconnect')).toBe(0)
    removeListener()
  })

  it('exits immediately when the foreground supervisor disconnects before Electron is ready', async () => {
    const parent = new EventEmitter()
    process.env[SERVE_SUPERVISOR_ENV] = '1'
    appMock.isReady.mockReturnValue(false)
    const { installServeSupervisorDisconnectQuit } = await import('./serve-update-handoff')

    installServeSupervisorDisconnectQuit(true, parent)
    parent.emit('disconnect')

    expect(appMock.exit).toHaveBeenCalledWith(SERVE_SUPERVISOR_STOP_EXIT_CODE)
    expect(appMock.quit).not.toHaveBeenCalled()
  })
})

function readState(root: string) {
  return parseServeUpdateHandoffState(
    JSON.parse(readFileSync(getServeUpdateHandoffPath(root), 'utf8'))
  )
}
