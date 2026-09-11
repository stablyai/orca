/**
 * What the remote-workspace export publishes when the renderer omits `session`, against the real
 * `Store`.
 *
 * The shipping debounced writer takes that fallback on every session write, and it used to read the
 * 'local' blob alone — so an SSH worktree whose tabs the main-process runtime had written to
 * `ssh:<targetId>` was projected as an explicit empty tab list. The upload is a
 * `replace-session` patch, which turns that absence into deletion on the host (#12721, #18173).
 *
 * Drives the real `Store` rather than a `getWorkspaceSession` fake: the whole defect is which
 * partition the read reaches, and a fake answers whatever the test tells it to.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'

const { getActiveMultiplexerMock, getSshConnectionStoreMock } = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn()
}))

const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

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
  ipcMain: {
    on: () => {},
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock,
  getSshConnectionStore: getSshConnectionStoreMock
}))

vi.mock('./remote-workspace-events', () => ({
  registerRemoteWorkspaceNotificationHandler: () => () => {}
}))

const { Store } = await import('../persistence/loading-store/store')
const { getDefaultWorkspaceSession } = await import('../../shared/constants')
const { _resetRemoteWorkspaceCachesForTests, registerRemoteWorkspaceHandlers } =
  await import('./remote-workspace')

const TARGET_ID = 'target-1'
const SSH_HOST_ID = `ssh:${TARGET_ID}` as const
const REPO_ID = 'repo-remote'
const WORKTREE_PATH = '/remote/checkout/feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

const OTHER_TARGET_ID = 'target-2'
const OTHER_SSH_HOST_ID = `ssh:${OTHER_TARGET_ID}` as const
const OTHER_REPO_ID = 'repo-other'
const OTHER_WORKTREE_ID = `${OTHER_REPO_ID}::/elsewhere/checkout/main`

function sshTarget(id: string, host: string): SshTarget {
  return { id, label: id, host, port: 22, username: 'alice' }
}

const target = sshTarget(TARGET_ID, 'one.example.com')
const otherTarget = sshTarget(OTHER_TARGET_ID, 'two.example.com')

function remoteRepo(id: string, path: string, connectionId: string): Repo {
  return { id, path, displayName: id, badgeColor: 'blue', addedAt: 1, connectionId } as Repo
}

function runtimeAuthoredTab(): TerminalTab {
  return {
    id: 'tab-runtime',
    ptyId: 'pty-runtime',
    worktreeId: WORKTREE_ID,
    title: 'claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

const stores: InstanceType<typeof Store>[] = []
let hostSnapshot: RemoteWorkspaceSnapshot

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.flush()
  }
  vi.restoreAllMocks()
})

beforeEach(() => {
  _resetRemoteWorkspaceCachesForTests()
  ipcHandlers.clear()
  hostSnapshot = {
    namespace: 'ns-target-1',
    revision: 4,
    updatedAt: 100,
    schemaVersion: 1,
    session: {
      activeWorktreePath: null,
      activeTabId: null,
      tabsByWorktreePath: {},
      terminalLayoutsByTabId: {}
    }
  }
  getSshConnectionStoreMock.mockReset()
  getSshConnectionStoreMock.mockReturnValue({
    listTargets: () => [target, otherTarget],
    getTarget: (targetId: string) =>
      [target, otherTarget].find((candidate) => candidate.id === targetId)
  })
  getActiveMultiplexerMock.mockReset()
  getActiveMultiplexerMock.mockImplementation((targetId: string) =>
    targetId === TARGET_ID
      ? {
          request: (method: string, params: Record<string, unknown>) => {
            if (method === 'workspace.get') {
              return Promise.resolve(hostSnapshot)
            }
            const patch = params.patch as { session: RemoteWorkspaceSession }
            hostSnapshot = {
              ...hostSnapshot,
              revision: hostSnapshot.revision + 1,
              session: patch.session
            }
            return Promise.resolve({ ok: true, snapshot: hostSnapshot })
          }
        }
      : undefined
  )
})

/** The observed shape from #12721: the runtime owns the tab list in `ssh:<targetId>` while the
 *  local blob still carries the worktree key with an empty list. */
function createStrandedStore(): InstanceType<typeof Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-ssh-partition-export-')))
  const store = new Store({ dataFile: join(dir, 'orca-data.json') })
  stores.push(store)
  store.addRepo(remoteRepo(REPO_ID, '/remote/checkout', TARGET_ID))
  // A second populated SSH partition: the fallback has to reach the publishing target's own
  // partition, not merely "some" partition that happens to hold tabs.
  store.addRepo(remoteRepo(OTHER_REPO_ID, '/elsewhere/checkout', OTHER_TARGET_ID))
  store.setWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKTREE_ID]: [] }
  })
  store.setWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE_ID]: [runtimeAuthoredTab()] }
    },
    SSH_HOST_ID
  )
  store.setWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [OTHER_WORKTREE_ID]: [
          { ...runtimeAuthoredTab(), id: 'tab-other', worktreeId: OTHER_WORKTREE_ID }
        ]
      }
    },
    OTHER_SSH_HOST_ID
  )
  return store
}

async function publishToConnectedTarget(store: InstanceType<typeof Store>): Promise<void> {
  registerRemoteWorkspaceHandlers(store, () => null)
  const get = ipcHandlers.get('remoteWorkspace:get')
  const set = ipcHandlers.get('remoteWorkspace:setForConnectedTargets')
  if (!get || !set) {
    throw new Error('remote workspace handlers were never registered')
  }
  const observed = (await get(null, { targetId: TARGET_ID })) as {
    revision: number
    hostObservationToken: string
  }
  await set(null, {
    // The shipping debounced writer omits `session` and relies on the main-side fallback.
    hydratedTargetIds: [TARGET_ID],
    expectedRevisionsByTargetId: { [TARGET_ID]: observed.revision },
    expectedHostObservationTokensByTargetId: { [TARGET_ID]: observed.hostObservationToken }
  })
}

describe('remoteWorkspace:setForConnectedTargets session fallback', () => {
  it('publishes tabs the runtime persisted into the target ssh partition', async () => {
    const store = createStrandedStore()

    await publishToConnectedTarget(store)

    expect(hostSnapshot.session.tabsByWorktreePath[WORKTREE_PATH]?.map((tab) => tab.id)).toEqual([
      'tab-runtime'
    ])
  })

  it('never retracts a populated worktree from the host snapshot, by emptying it or by omitting it', async () => {
    // The deletion step itself: `replace-session` makes the exported projection authoritative in
    // whole, so BOTH shapes destroy the host's copy — an empty list for the path, and no entry for
    // the path at all. `not.toEqual([])` alone is satisfied by `undefined`, which is the second of
    // those, so it named a guard it only half checked.
    const store = createStrandedStore()

    await publishToConnectedTarget(store)

    expect(Object.hasOwn(hostSnapshot.session.tabsByWorktreePath, WORKTREE_PATH)).toBe(true)
    expect(hostSnapshot.session.tabsByWorktreePath[WORKTREE_PATH]?.map((tab) => tab.id)).toEqual([
      'tab-runtime'
    ])
  })
})
