import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BROWSER_SIDECAR_OWNER_ENV } from '../../shared/browser-sidecar-lifetime'
import { installServeSupervisorDisconnectQuit } from './serve-update-handoff'

const { quit } = vi.hoisted(() => ({ quit: vi.fn() }))
vi.mock('../startup/quit/process-quit-request', () => ({ quitProcess: quit }))
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => {
    throw new Error('No profile access for sidecar owner')
  }
}))

beforeEach(() => {
  quit.mockReset()
  vi.stubEnv(BROWSER_SIDECAR_OWNER_ENV, '1')
})
afterEach(() => vi.unstubAllEnvs())

it('couples the browser to its IPC owner on every platform and removes the inherited marker', () => {
  const parent = Object.assign(new EventEmitter(), { connected: true })
  const dispose = installServeSupervisorDisconnectQuit(true, parent)
  expect(quit).not.toHaveBeenCalled()
  expect(process.env[BROWSER_SIDECAR_OWNER_ENV]).toBeUndefined()
  parent.emit('disconnect')
  parent.emit('disconnect')
  expect(quit).toHaveBeenCalledOnce()
  dispose()
})
