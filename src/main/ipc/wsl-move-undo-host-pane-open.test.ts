import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { setWslMoveReloadableWindow } from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests
} from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite-stores'
import {
  isHostSpawnFencedForWslMoveUndo,
  resetWslMoveUndoSpawnFencesForTests
} from '../persistence/moving-wsl-projects/wsl-move-undo-spawn-fence'
import type { WslMoveHostCopyStop } from '../persistence/moving-wsl-projects/wsl-move-host-copy-stop'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))

import { registerWslMoveHandlers } from './wsl-move-handlers'

const MAIN_WINDOW_ID = 7
const HOST = cutover('move-1', 'destination-committed').destinationEnvironmentId
let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-undo-open-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  registerWslMoveDesktopRewriteStore({ id: 'renderer-a', side: 'renderer' })
  seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
  loadWslMoveFence(userDataPath)
})
afterEach(() => {
  vi.unstubAllEnvs()
  setWslMoveReloadableWindow(() => null)
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveFenceForTests()
  resetWslMoveUndoSpawnFencesForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

function register(stopHostCopies: () => Promise<WslMoveHostCopyStop>): void {
  registerWslMoveHandlers(
    () => userDataPath,
    (senderId) => senderId === MAIN_WINDOW_ID,
    undefined,
    () => ({ stopHostCopies })
  )
}

const flushStorageData = vi.fn()
const undo = (sender: unknown = { id: MAIN_WINDOW_ID, session: { flushStorageData } }) =>
  handlers.get('wslMove:useProjectHereAgain')?.({ sender }, { kind: 'repo', id: 'repo-1' })

// The open host pane resumed its agent on the host 1.6 s after undo stopped it.
describe('undo with the host pane open', () => {
  it("refuses the window's host starts from the stop until the reloaded page has loaded", async () => {
    let fencedDuringStop = false
    register(async () => {
      // The open pane sees its terminal exit and starts it again on the host.
      fencedDuringStop = isHostSpawnFencedForWslMoveUndo(HOST, 'terminal.create')
      return 'stopped'
    })
    const page = { loaded: () => {} }
    const mainWindow = {
      id: MAIN_WINDOW_ID,
      session: { flushStorageData },
      isDestroyed: () => false,
      reload: vi.fn(),
      allowUnload: () => () => {},
      onLoadedOrGone: (listener: () => void) => {
        page.loaded = listener
        return () => {}
      }
    }
    setWslMoveReloadableWindow(() => mainWindow)

    expect(await undo(mainWindow)).toMatchObject({ released: true })
    expect(fencedDuringStop).toBe(true)
    // The old page can still start host panes until the reload replaces it.
    expect(isHostSpawnFencedForWslMoveUndo(HOST, 'terminal.ensureAgentSession')).toBe(true)
    expect(isHostSpawnFencedForWslMoveUndo(HOST, 'terminal.list')).toBe(false)
    expect(isHostSpawnFencedForWslMoveUndo('wsl:other', 'terminal.create')).toBe(false)
    page.loaded()
    expect(isHostSpawnFencedForWslMoveUndo(HOST, 'terminal.create')).toBe(false)
  })

  it.each(['still-running', 'unreachable'] as const)(
    'lifts the fence when the host stop is %s, leaving the host usable',
    async (stop) => {
      register(async () => stop)
      expect(await undo()).toMatchObject({ released: false })
      expect(isHostSpawnFencedForWslMoveUndo(HOST, 'terminal.create')).toBe(false)
    }
  )
})
