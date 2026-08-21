import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SERVE_UPDATE_HANDOFF_PATH_ENV,
  getServeUpdateHandoffPath,
  parseServeUpdateHandoffState
} from '../shared/serve-update-handoff'

const { appMock, getCanonicalUserDataPathMock } = vi.hoisted(() => ({
  appMock: { getVersion: vi.fn(() => '1.0.51'), quit: vi.fn() },
  getCanonicalUserDataPathMock: vi.fn()
}))

vi.mock('electron', () => ({ app: appMock }))
vi.mock('./persistence', () => ({ getCanonicalUserDataPath: getCanonicalUserDataPathMock }))

describe('serve update handoff', () => {
  let root: string

  beforeEach(() => {
    vi.resetModules()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    root = mkdtempSync(join(tmpdir(), 'orca-serve-handoff-'))
    getCanonicalUserDataPathMock.mockReturnValue(root)
    process.env[SERVE_UPDATE_HANDOFF_PATH_ENV] = getServeUpdateHandoffPath(root)
  })

  afterEach(() => {
    delete process.env[SERVE_UPDATE_HANDOFF_PATH_ENV]
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
})

function readState(root: string) {
  return parseServeUpdateHandoffState(
    JSON.parse(readFileSync(getServeUpdateHandoffPath(root), 'utf8'))
  )
}
