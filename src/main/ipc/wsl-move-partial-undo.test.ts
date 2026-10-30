import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslMoveCutover } from '../../shared/wsl-move/wsl-move-cutover'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import {
  isWslMoveProjectBlocked,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { setWslMoveReloadableWindow } from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests
} from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite-stores'

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
const useHere = (repoId: string) =>
  handlers.get('wslMove:useProjectHereAgain')?.(
    { sender: { id: MAIN_WINDOW_ID, session: { flushStorageData: vi.fn() } } },
    { kind: 'repo', id: repoId }
  )

let userDataPath: string
const touched: string[] = []
const record = (step: string) => (move: WslMoveCutover) => {
  touched.push(`${step}:${move.migrationId}`)
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-partial-undo-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  registerWslMoveDesktopRewriteStore({ id: 'renderer-a', side: 'renderer' })
  touched.length = 0
  // P moved first; Q, a different project, moved after it to the same host.
  const rewritten = { rewrittenStores: ['renderer-a'] }
  seedWslMoveCutover(userDataPath, { ...cutover('move-p', 'retained'), ...rewritten })
  seedWslMoveCutover(userDataPath, {
    ...cutover('move-q', 'retained', { supersedesMigrationId: 'move-p' }, { repoIds: ['repo-q'] }),
    ...rewritten
  })
  loadWslMoveFence(userDataPath)
  registerWslMoveHandlers(
    () => userDataPath,
    (senderId) => senderId === MAIN_WINDOW_ID,
    undefined,
    () => ({
      stopHostAutomations: async (move) => {
        record('automations')(move)
        return { outcome: 'stopped', restore: async () => {}, applyHere: () => () => {} }
      },
      stopHostCopies: async (move) => {
        record('copies')(move)
        return 'stopped'
      },
      refocusHere: record('refocus')
    })
  )
  setWslMoveReloadableWindow(() => null)
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const journal = () =>
  listWslMoveCutovers(userDataPath)
    .map((move) => move.migrationId)
    .toSorted()
const moved = (repoId: string) => isWslMoveProjectBlocked(undefined, { repoId })

// Flag-on checklist "Partial undo of an older move (P then Q)": undo P alone, with Q moved after it.
describe('undo of an older move while a newer one stands', () => {
  it('refuses P, naming Q, and leaves both moves, their host copies and automations as they were', async () => {
    expect(await useHere('repo-1')).toEqual({
      released: false,
      reason: 'superseded',
      newerMove: { repoIds: ['repo-q'], folderWorkspaceIds: [] }
    })
    expect(touched).toEqual([])
    expect(journal()).toEqual(['move-p', 'move-q'])
    expect(listWslMoveCutovers(userDataPath).map((move) => move.rewrittenStores)).toEqual([
      ['renderer-a'],
      ['renderer-a']
    ])
    expect([moved('repo-1'), moved('repo-q')]).toEqual([true, true])
  })

  it('brings Q back alone, then P, each touching only its own move on the host', async () => {
    expect(await useHere('repo-q')).toMatchObject({ released: true, repoIds: ['repo-q'] })
    expect(touched).toEqual(['automations:move-q', 'copies:move-q', 'refocus:move-q'])
    expect(journal()).toEqual(['move-p'])
    expect([moved('repo-1'), moved('repo-q')]).toEqual([true, false])

    touched.length = 0
    expect(await useHere('repo-1')).toMatchObject({ released: true, repoIds: ['repo-1'] })
    expect(touched).toEqual(['automations:move-p', 'copies:move-p', 'refocus:move-p'])
    expect(journal()).toEqual([])
    expect(moved('repo-1')).toBe(false)
  })
})
