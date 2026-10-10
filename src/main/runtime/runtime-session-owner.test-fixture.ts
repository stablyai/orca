import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { Store } from '../persistence'
import { createSqliteTestStore, closeTestStores } from '../persistence-test-harness'
import { makeTerminalTab } from '../persistence-session-fixtures'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { createWorktreeIdentity, type WorktreeIdentity } from '../../shared/worktree/identity'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { PtyProcessInfo } from '../providers/types'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import { WORKTREE_METHODS } from './rpc/methods/worktree'

export const SESSION_OWNER_WORKTREE_ID = 'repo-session-owner::/repo/checkout'
const directories: string[] = []

class SessionOwnerRuntime extends OrcaRuntimeService {
  publish(snapshot: RuntimeMobileSessionTabsSnapshot) {
    return this.storeMobileSessionSnapshot(snapshot.worktree, snapshot)
  }

  sync(snapshots: RuntimeMobileSessionTabsSnapshot[]) {
    return this.syncMobileSessionTabs(snapshots)
  }

  retire(raw: string) {
    if (!this.store) {
      throw new Error('Missing fixture store')
    }
    this.removeWorktreeMetadataAndHistory(
      this.store,
      SESSION_OWNER_WORKTREE_ID,
      `ssh:session-${raw}`
    )
  }

  current() {
    return this.mobileSessionTabsByWorktree.get(SESSION_OWNER_WORKTREE_ID)
  }

  rescue() {
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(null)
  }

  registerRescuePane(raw: string) {
    const ptyId = `rescue-${raw}`
    this.registerPty(ptyId, SESSION_OWNER_WORKTREE_ID, `session-${raw}`, {
      tabId: `rescue-tab-${raw}`,
      leafId: randomUUID()
    })
    this.setPairedRendererSessionOwnership(ptyId, true)
  }

  registerOwnedLocalPane(ptyId: string, tabId: string, leafId: string) {
    this.registerPty(ptyId, SESSION_OWNER_WORKTREE_ID, null, { tabId, leafId })
    const record = this.ptysById.get(ptyId)
    if (!record) {
      throw new Error('Missing registered local pane')
    }
    record.runtimeSessionOwned = true
    this.setPairedRendererSessionOwnership(ptyId, true)
  }

  isRuntimeSessionOwned(ptyId: string) {
    return this.ptysById.get(ptyId)?.runtimeSessionOwned === true
  }

  notify() {
    this.notifyMobileSessionTabsChanged(SESSION_OWNER_WORKTREE_ID)
    this.flushScheduledMobileSessionTabsChanged(SESSION_OWNER_WORKTREE_ID)
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  unregisterSshGitProvider('session-a')
  unregisterSshGitProvider('session-b')
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

export function createSessionOwnerFixture(reversed = false, duplicated = true, graphReady = true) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-session-owner-'))
  directories.push(directory)
  const store = createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
  const identities = new Map<string, WorktreeIdentity>()
  const raws = duplicated ? (reversed ? ['b', 'a'] : ['a', 'b']) : ['b']
  for (const raw of raws) {
    const hostId = `ssh:session-${raw}` as const
    store.addRepo({
      id: 'repo-session-owner',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: 'blue',
      addedAt: 1,
      executionHostId: hostId,
      connectionId: `session-${raw}`
    })
    const meta = store.setWorktreeMetaForHost(SESSION_OWNER_WORKTREE_ID, hostId, {})
    if (!meta.instanceId) {
      throw new Error('Missing persisted occupant')
    }
    identities.set(
      raw,
      createWorktreeIdentity({
        worktreeId: SESSION_OWNER_WORKTREE_ID,
        executionHostId: hostId,
        instanceId: meta.instanceId
      })
    )
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree[SESSION_OWNER_WORKTREE_ID] = [1, 2].map((index) =>
      makeTerminalTab({
        id: `tab-${raw}-${index}`,
        worktreeId: SESSION_OWNER_WORKTREE_ID,
        title: `raw-${raw}`,
        ptyId: null
      })
    )
    session.tabGroups = {
      [SESSION_OWNER_WORKTREE_ID]: [1, 2].map((index) => ({
        id: `group-${raw}-${index}`,
        worktreeId: SESSION_OWNER_WORKTREE_ID,
        tabOrder: [`tab-${raw}-${index}`],
        activeTabId: `tab-${raw}-${index}`
      }))
    }
    session.tabGroupLayouts = {
      [SESSION_OWNER_WORKTREE_ID]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: `group-${raw}-1` },
        second: { type: 'leaf', groupId: `group-${raw}-2` }
      }
    }
    store.setWorkspaceSession(session, hostId)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this registered fixture only lists; native and SSH transport are never started.
    registerSshGitProvider(`session-${raw}`, {
      listWorktrees: async () => [
        {
          path: '/repo/checkout',
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: false
        }
      ]
    } as never)
  }
  const runtime = new SessionOwnerRuntime(store)
  runtime.attachWindow(1)
  if (graphReady) {
    runtime.markGraphReady(1)
  }
  const inventory = vi.fn(async (_connectionId?: string | null): Promise<PtyProcessInfo[]> => [])
  const kill = vi.fn(() => true)
  runtime.setPtyController({
    write: () => true,
    kill,
    getForegroundProcess: async () => null,
    listProcesses: inventory
  })
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...WORKTREE_METHODS, ...SESSION_TAB_METHODS]
  })
  const identity = (raw: string) => {
    const owner = identities.get(raw)
    if (!owner) {
      throw new Error('Missing fixture owner')
    }
    return owner
  }
  const list = (raw: string) =>
    dispatcher.dispatch({
      id: `list-${raw}`,
      authToken: 'test',
      method: 'session.tabs.list',
      params: { worktree: `identity:${identity(raw).key}` }
    })
  return { store, runtime, dispatcher, inventory, kill, identity, list }
}

export function sessionOwnerDeferred() {
  let release: () => void = () => {}
  const promise = new Promise<PtyProcessInfo[]>((resolve) => {
    release = () => resolve([])
  })
  return { promise, release }
}
