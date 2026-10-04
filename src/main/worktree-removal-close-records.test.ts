import { closeTestStores, createSqliteTestStore } from './persistence-test-harness'
// Why this file exists: removing a workspace's session rows must take its close records with it,
// or they hold cap slots until the TTL and read as "emptied on purpose" for a new workspace at the
// same path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { toSshExecutionHostId } from '../shared/execution-host'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import {
  MAX_CLOSED_TERMINAL_TAB_TOMBSTONES,
  recordClosedTerminalTabTombstone,
  type ClosedTerminalTabTombstonesByTabId
} from '../shared/closed-terminal-tab-tombstones'

const testState = { dir: '' }

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))

async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

const REMOVED = 'repo-a::/workspace/removed'
const KEPT = 'repo-a::/workspace/kept'
const OTHER_REPO = 'repo-b::/workspace/other'
const SSH_HOST = toSshExecutionHostId('target-1')

function records(
  entries: [tabId: string, worktreeId: string][],
  now = Date.now()
): ClosedTerminalTabTombstonesByTabId {
  return Object.fromEntries(
    entries.map(([tabId, worktreeId]) => [
      tabId,
      { closedAt: now, worktreeId, reason: 'user' as const }
    ])
  )
}

function sessionWithRecords(map: ClosedTerminalTabTombstonesByTabId) {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [REMOVED]: [], [KEPT]: [] },
    closedTerminalTabTombstonesByTabId: map
  }
}

describe('close records on workspace removal', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('drops only the removed worktree’s records', async () => {
    const store = await createStore()
    store.setWorktreeMeta(REMOVED, {})
    store.setWorkspaceSession(
      sessionWithRecords(
        records([
          ['closed-removed', REMOVED],
          ['closed-kept', KEPT]
        ])
      )
    )

    store.removeWorktreeMeta(REMOVED)

    expect(
      Object.keys(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId ?? {})
    ).toEqual(['closed-kept'])
  })

  it('drops the records in the SSH host’s partition on a remote removal', async () => {
    const store = await createStore()
    store.setWorktreeMeta(REMOVED, { hostId: SSH_HOST })
    store.setWorkspaceSession(
      sessionWithRecords(
        records([
          ['closed-removed', REMOVED],
          ['closed-kept', KEPT]
        ])
      ),
      SSH_HOST
    )

    store.removeWorktreeMeta(REMOVED, SSH_HOST)

    expect(
      Object.keys(store.getWorkspaceSession(SSH_HOST).closedTerminalTabTombstonesByTabId ?? {})
    ).toEqual(['closed-kept'])
  })

  // Why: repo ids and paths repeat across hosts; the local owner of the same id is still live.
  it('keeps a same-id worktree’s records on another host when one host’s copy is removed', async () => {
    const store = await createStore()
    const repo = { id: 'repo-a', displayName: 'A', badgeColor: 'gray', addedAt: 1 }
    store.addRepo({ ...repo, path: '/workspace/repo-a' })
    store.addRepo({
      ...repo,
      path: '/remote/repo-a',
      connectionId: 'target-1',
      executionHostId: SSH_HOST
    })
    store.setWorktreeMeta(REMOVED, { hostId: SSH_HOST })
    store.setWorkspaceSession(sessionWithRecords(records([['local-tab', REMOVED]])))
    store.setWorkspaceSession(sessionWithRecords(records([['ssh-tab', REMOVED]])), SSH_HOST)

    store.removeWorktreeMeta(REMOVED, SSH_HOST)

    expect(
      Object.keys(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId ?? {})
    ).toEqual(['local-tab'])
    expect(store.getWorkspaceSession(SSH_HOST).closedTerminalTabTombstonesByTabId).toEqual({})
  })

  it('drops a removed folder workspace’s records from every partition', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const folder = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Scratch' })
    const folderKey = folderWorkspaceKey(folder.id)
    store.setWorkspaceSession(
      sessionWithRecords(
        records([
          ['closed-folder', folderKey],
          ['closed-kept', KEPT]
        ])
      )
    )
    store.setWorkspaceSession(sessionWithRecords(records([['ssh-folder', folderKey]])), SSH_HOST)

    expect(store.removeFolderWorkspace(folder.id)).toBe(true)

    expect(
      Object.keys(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId ?? {})
    ).toEqual(['closed-kept'])
    expect(store.getWorkspaceSession(SSH_HOST).closedTerminalTabTombstonesByTabId).toEqual({})
  })

  // Why the removed worktree has no meta here: records alone must still mark it as the repo's.
  it('drops every worktree’s records when its project is removed, and keeps other projects’', async () => {
    const store = await createStore()
    store.addRepo({
      id: 'repo-a',
      path: '/workspace/repo-a',
      displayName: 'A',
      badgeColor: 'gray',
      addedAt: 1
    })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      closedTerminalTabTombstonesByTabId: records([
        ['closed-a', REMOVED],
        ['closed-a2', KEPT],
        ['closed-b', OTHER_REPO]
      ])
    })

    store.removeProject('repo-a')

    expect(
      Object.keys(store.getWorkspaceSession().closedTerminalTabTombstonesByTabId ?? {})
    ).toEqual(['closed-b'])
  })

  // Why: dead records used to hold cap slots until their TTL, so fresh closes evicted a live one.
  it('frees the removed worktree’s cap slots, so later closes keep a live worktree’s record', async () => {
    const store = await createStore()
    const now = Date.now()
    const dead = Array.from(
      { length: MAX_CLOSED_TERMINAL_TAB_TOMBSTONES - 1 },
      (_, index): [string, string] => [`dead-${index}`, REMOVED]
    )
    store.setWorktreeMeta(REMOVED, {})
    store.setWorkspaceSession(
      sessionWithRecords({
        ...records(dead, now),
        ...records([['live-kept', KEPT]], now - 60_000)
      })
    )

    store.removeWorktreeMeta(REMOVED)
    let map = store.getWorkspaceSession().closedTerminalTabTombstonesByTabId
    for (let index = 0; index < 2; index += 1) {
      map = recordClosedTerminalTabTombstone(
        map,
        `fresh-${index}`,
        { worktreeId: KEPT },
        now + index
      )
    }

    expect(map?.['live-kept']).toBeDefined()
  })
})
