import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { setWslMoveReloadableWindow } from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

import { registerWslMoveHandlers } from './wsl-move-handlers'

const MAIN_WINDOW_ID = 7
const sender = { id: MAIN_WINDOW_ID, session: { flushStorageData: vi.fn() } }
const invoke = (channel: string, request?: unknown) => handlers.get(channel)?.({ sender }, request)

// Stage 1: the WSL hosts setting governs new work only; with it off, a moved project still serves.
describe('WSL move IPC with the WSL hosts setting off', () => {
  let userDataPath: string
  const driverDeps = vi.fn(() => {
    throw new Error('a new move must not build the driver')
  })
  const stopHostCopies = vi.fn(async () => 'stopped' as const)

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-setting-off-'))
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    loadWslMoveFence(userDataPath)
    driverDeps.mockClear()
    stopHostCopies.mockClear()
    registerWslMoveHandlers(
      () => userDataPath,
      (senderId) => senderId === MAIN_WINDOW_ID,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused move never calls it; the stub throws if one does.
      driverDeps as never,
      () => ({ stopHostCopies }),
      () => ({ experimentalWslHosts: false })
    )
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    resetWslMoveFenceForTests()
    setWslMoveReloadableWindow(() => null)
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('refuses a new move and its preview, building nothing', async () => {
    for (const channel of ['wslMove:preview', 'wslMove:start']) {
      expect(await invoke(channel, { distro: 'Ubuntu', repoIds: ['repo-1'] })).toEqual({
        outcome: 'refused',
        code: 'wsl_move_unavailable',
        detail: 'wsl-hosts-off'
      })
    }
    expect(driverDeps).not.toHaveBeenCalled()
  })

  it('still brings a moved project back ("Use on this computer again")', async () => {
    const page = { loaded: () => {} }
    const mainWindow = {
      id: MAIN_WINDOW_ID,
      isDestroyed: () => false,
      reload: vi.fn(),
      allowUnload: () => () => {},
      onLoadedOrGone: (listener: () => void) => {
        page.loaded = listener
        return () => {}
      }
    }
    setWslMoveReloadableWindow(() => mainWindow)
    const result = await handlers.get('wslMove:useProjectHereAgain')?.(
      { sender: mainWindow },
      { kind: 'repo', id: 'repo-1' }
    )
    expect(result).toMatchObject({ released: true })
    expect(stopHostCopies).toHaveBeenCalledOnce()
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    await new Promise((resolve) => setImmediate(resolve))
    page.loaded()
  })
})
