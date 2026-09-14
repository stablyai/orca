/**
 * Drives the real `Store`, because the value of the prune gate is entirely in whether the shipping
 * write paths signal it. A mutation that unwires the call site survives any test that pokes the gate
 * module directly.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('./store')
const {
  __resetLocalWorktreeMetadataPruneGateForTests,
  isLocalWorktreeMetadataPruneDue,
  markLocalWorktreeMetadataPruneStarted
} = await import('../../local-worktree-metadata-prune-gate')

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/tmp/worktree-a`

const stores: InstanceType<typeof Store>[] = []

beforeEach(() => {
  __resetLocalWorktreeMetadataPruneGateForTests()
})

afterEach(() => {
  // Leaving a debounced save armed would write into a temp dir after the test file finishes.
  for (const store of stores.splice(0)) {
    store.flush()
  }
  vi.restoreAllMocks()
})

function createStore(): InstanceType<typeof Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-store-prune-gate-')))
  const store = new Store({ dataFile: join(dir, 'orca-data.json') })
  stores.push(store)
  return store
}

/** Park the gate the way a completed hygiene pass does. */
function parkGate(): void {
  markLocalWorktreeMetadataPruneStarted(REPO_ID)
  expect(isLocalWorktreeMetadataPruneDue(REPO_ID)).toBe(false)
}

describe('store signals to the worktree metadata prune gate', () => {
  it('re-arms the gate when a session releases its claim on a worktree', () => {
    const store = createStore()
    store.setWorkspaceSession({
      activeRepoId: REPO_ID,
      activeWorktreeId: WORKTREE_ID,
      activeTabId: 'tab-1',
      tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1', worktreeId: WORKTREE_ID }] },
      terminalLayoutsByTabId: {}
    } as unknown as WorkspaceSessionState)
    parkGate()

    store.removeWorkspaceSessionStateForWorktree(WORKTREE_ID)

    expect(isLocalWorktreeMetadataPruneDue(REPO_ID)).toBe(true)
  })

  it('re-arms the gate when a metadata row is removed', () => {
    const store = createStore()
    store.setWorktreeMeta(WORKTREE_ID, { displayName: 'a', hostId: 'local' })
    parkGate()

    store.removeWorktreeMeta(WORKTREE_ID)

    expect(isLocalWorktreeMetadataPruneDue(REPO_ID)).toBe(true)
  })

  it('leaves the gate parked for writes that only add or update a claim', () => {
    const store = createStore()
    parkGate()

    store.setWorktreeMeta(WORKTREE_ID, { displayName: 'a', hostId: 'local' })
    store.setWorktreeMeta(WORKTREE_ID, { displayName: 'b', hostId: 'local' })

    // Why this matters: the worktree listing itself stamps metadata on every scan, so a gate that
    // re-armed on ordinary writes would restore the storm it exists to stop (#17775).
    expect(isLocalWorktreeMetadataPruneDue(REPO_ID)).toBe(false)
  })
})
