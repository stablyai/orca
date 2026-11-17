import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { Store } from '../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import {
  holdWslMoveWindowWritesForCommit,
  setWslMoveReloadableWindow,
  settleWslMoveWindowWriteHoldForCommit
} from '../persistence/moving-wsl-projects/quiescence/wsl-move-window-write-hold'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { WorkspaceSessionPatch } from '../../shared/workspace-session/workspace-session-state-types'
import { registerSessionHandlers } from './session'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const HOST = 'ssh:conn-1'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  vi.mocked(ipcMain.handle).mockReset()
})

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-session-patch-'))
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(
      join(directory, 'profile-state.db'),
      'session-patch'
    )
  })
  cleanups.push(() => {
    store.freezeWrites()
    rmSync(directory, { recursive: true, force: true })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: window-owned session:patch never reads the runtime.
  registerSessionHandlers(store, {} as OrcaRuntimeService)
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === 'session:patch')![1]
  // IPC hands main a fresh copy of every argument.
  const patch = (args: WorkspaceSessionPatch): unknown =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler ignores its IPC event.
    handler({} as never, structuredClone(args), HOST)
  return { store, patch }
}

const activeTab = (tabId: string): WorkspaceSessionPatch => ({
  activeTabIdByWorktree: { 'repo-1::/work/a': tabId }
})

describe('session:patch', () => {
  it('rewrites a repeated patch once another writer replaced the partition', () => {
    const { store, patch } = harness()
    patch(activeTab('tab-1'))
    patch(activeTab('tab-1'))
    expect(store.getWorkspaceSession(HOST).activeTabIdByWorktree).toEqual(
      activeTab('tab-1').activeTabIdByWorktree
    )

    store.removeWorkspaceSessionHost(HOST)
    patch(activeTab('tab-1'))
    expect(store.getWorkspaceSession(HOST).activeTabIdByWorktree).toEqual(
      activeTab('tab-1').activeTabIdByWorktree
    )

    patch(activeTab('tab-2'))
    expect(store.getWorkspaceSession(HOST).activeTabIdByWorktree).toEqual(
      activeTab('tab-2').activeTabIdByWorktree
    )
  })

  it('rewrites a repeated patch once another writer changed the partition in place', () => {
    const { store, patch } = harness()
    patch(activeTab('tab-1'))
    // Binding writes change the stored partition object without replacing it.
    store.getWorkspaceSession(HOST).activeTabIdByWorktree['repo-1::/work/a'] = 'tab-9'

    patch(activeTab('tab-1'))
    expect(store.getWorkspaceSession(HOST).activeTabIdByWorktree).toEqual(
      activeTab('tab-1').activeTabIdByWorktree
    )
  })

  it('writes a patch a WSL move hold dropped once the hold lifts', () => {
    const { store, patch } = harness()
    patch(activeTab('tab-1'))
    setWslMoveReloadableWindow(() => ({
      isDestroyed: () => false,
      reload: () => {},
      allowUnload: () => () => {},
      onLoadedOrGone: () => () => {}
    }))
    cleanups.push(() => setWslMoveReloadableWindow(() => null))
    holdWslMoveWindowWritesForCommit()
    patch(activeTab('tab-2'))
    expect(store.getWorkspaceSession(HOST).activeTabIdByWorktree).toEqual(
      activeTab('tab-1').activeTabIdByWorktree
    )

    settleWslMoveWindowWriteHoldForCommit(false)
    patch(activeTab('tab-2'))
    expect(store.getWorkspaceSession(HOST).activeTabIdByWorktree).toEqual(
      activeTab('tab-2').activeTabIdByWorktree
    )
  })
})
