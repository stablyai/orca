import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BROWSER_SIDECAR_OWNER_ENV } from '../shared/browser-sidecar-lifetime'
import { installServeSupervisorDisconnectQuit } from './serve-update-handoff'

const { quit } = vi.hoisted(() => ({ quit: vi.fn() }))
vi.mock('./startup/process-quit-request', () => ({ quitProcess: quit }))
vi.mock('./persistence', () => ({
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

it('quits when the owner disappeared before startup finished', () => {
  const parent = Object.assign(new EventEmitter(), { connected: false })
  installServeSupervisorDisconnectQuit(true, parent)
  expect(quit).toHaveBeenCalledOnce()
})

it('removes the listener on disposal', () => {
  const parent = Object.assign(new EventEmitter(), { connected: true })
  installServeSupervisorDisconnectQuit(true, parent)()
  parent.emit('disconnect')
  expect(quit).not.toHaveBeenCalled()
})
