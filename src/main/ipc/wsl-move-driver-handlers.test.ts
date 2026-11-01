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
const running = vi.hoisted(() => ({ any: false }))
vi.mock('../persistence/moving-wsl-projects/wsl-move-running-moves', () => ({
  isAnyWslMoveRunning: () => running.any
}))
const track = vi.hoisted(() => vi.fn())
vi.mock('../telemetry/client', () => ({ track }))

import { registerWslMoveHandlers } from './wsl-move-handlers'

const MAIN_WINDOW_ID = 7
const progress = vi.fn()
const deps = vi.fn(() => ({ now: () => new Date(0), progress }))
const invoke = (channel: string, request?: unknown, senderId = MAIN_WINDOW_ID) =>
  handlers.get(channel)?.({ sender: { id: senderId } }, request)

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  deps.mockClear()
  track.mockClear()
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
    expect(driver.moveProjectsToWslHost).toHaveBeenCalledWith(
      expect.objectContaining({ now: expect.any(Function) }),
      { distro: 'Ubuntu' }
    )
    // The move's start and outcome are reported.
    expect(track.mock.calls.map(([, props]) => props.outcome)).toEqual(['started', 'finished'])
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

  // The quit prompt asks this; with the gate closed it is always false, so nothing prompts.
  it('says whether a move is running, and never with the gate closed', async () => {
    running.any = true
    expect(await invoke('wslMove:isRunning')).toBe(true)
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    expect(await invoke('wslMove:isRunning')).toBe(false)
    running.any = false
  })
})
