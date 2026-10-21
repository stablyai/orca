import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))
const driver = vi.hoisted(() => ({
  previewWslMove: vi.fn(async () => ({ outcome: 'ready' })),
  moveProjectsToWslHost: vi.fn(async () => ({ outcome: 'moved' })),
  cancelWslMove: vi.fn(() => true)
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-driver', () => driver)

import { registerWslMoveHandlers } from './wsl-move-handlers'

const MAIN_WINDOW_ID = 7
const deps = vi.fn(() => ({}))
const invoke = (channel: string, request?: unknown, senderId = MAIN_WINDOW_ID) =>
  handlers.get(channel)?.({ sender: { id: senderId } }, request)

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  deps.mockClear()
  for (const fn of Object.values(driver)) {
    fn.mockClear()
  }
  registerWslMoveHandlers(
    () => '/unused',
    (senderId) => senderId === MAIN_WINDOW_ID,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The driver is mocked; the handler only passes deps through.
    deps as never
  )
})
afterEach(() => vi.unstubAllEnvs())

describe('WSL move driver IPC', () => {
  it('previews, starts and cancels a move from the main window', async () => {
    expect(await invoke('wslMove:preview', { distro: 'Ubuntu', repoIds: ['r1'] })).toEqual({
      outcome: 'ready'
    })
    expect(await invoke('wslMove:start', { distro: 'Ubuntu' })).toEqual({ outcome: 'moved' })
    expect(invoke('wslMove:cancel', 'Ubuntu')).toBe(true)
    expect(driver.moveProjectsToWslHost).toHaveBeenCalledWith({}, { distro: 'Ubuntu' })
  })

  it('is unreachable with the internal WSL hosts gate closed: nothing is built or run', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    const refused = { outcome: 'refused', code: 'wsl_move_unavailable' }
    expect(await invoke('wslMove:preview', { distro: 'Ubuntu' })).toEqual(refused)
    expect(await invoke('wslMove:start', { distro: 'Ubuntu' })).toEqual(refused)
    expect(invoke('wslMove:cancel', 'Ubuntu')).toBe(false)
    expect(deps).not.toHaveBeenCalled()
    expect(driver.previewWslMove).not.toHaveBeenCalled()
    expect(driver.moveProjectsToWslHost).not.toHaveBeenCalled()
    expect(driver.cancelWslMove).not.toHaveBeenCalled()
  })

  it('refuses another window, and a malformed request', async () => {
    expect(await invoke('wslMove:start', { distro: 'Ubuntu' }, 99)).toMatchObject({
      code: 'wsl_move_unavailable',
      detail: 'not-main-window'
    })
    for (const bad of [
      undefined,
      'Ubuntu',
      { distro: '' },
      { distro: '..\\x' },
      { distro: 'U', repoIds: [1] }
    ]) {
      expect(await invoke('wslMove:start', bad)).toMatchObject({ detail: 'invalid-request' })
    }
    expect(driver.moveProjectsToWslHost).not.toHaveBeenCalled()
  })
})
