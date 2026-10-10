import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WORKTREE = 'repo::G:\\git\\example'
const ALIAS = 'repo::G:/git/example'
const LEAF = '11111111-1111-4111-8111-111111111111'
const TAB = `tab::${LEAF}`

function snapshot(worktree = WORKTREE): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: TAB,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: TAB,
        parentTabId: 'tab',
        leafId: LEAF,
        ptyId: 'pty-existing',
        title: 'Existing conversation',
        isActive: true
      }
    ]
  }
}

function liveRuntime(
  worktree = WORKTREE,
  additionalSnapshots: RuntimeMobileSessionTabsSnapshot[] = []
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  runtime.attachWindow(1)
  publishGraph(runtime, worktree, additionalSnapshots)
  return runtime
}

function publishGraph(
  runtime: OrcaRuntimeService,
  worktree = WORKTREE,
  additionalSnapshots: RuntimeMobileSessionTabsSnapshot[] = []
): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: worktree,
        title: 'Existing conversation',
        activeLeafId: LEAF,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab',
        worktreeId: worktree,
        leafId: LEAF,
        paneRuntimeId: 1,
        ptyId: 'pty-existing',
        paneTitle: 'Existing conversation'
      }
    ],
    mobileSessionTabs: [snapshot(worktree), ...additionalSnapshots]
  })
}

describe('session tab workspace path aliases', () => {
  it.each([false, true])(
    'recovers a surviving renderer PTY without pinning an empty alias (discovered during refresh: %s)',
    async (duringRefresh) => {
      const runtime = new OrcaRuntimeService()
      runtime.attachWindow(1)
      const register = async () => {
        runtime.registerPty('pty-existing', WORKTREE, null, { tabId: 'tab', leafId: LEAF })
      }
      if (duringRefresh) {
        vi.spyOn(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replace only the inventory refresh to register the fixture PTY at the real asynchronous discovery boundary.
          runtime as unknown as { refreshMobileSessionPtyRecords: () => Promise<void> },
          'refreshMobileSessionPtyRecords'
        ).mockImplementation(register)
      } else {
        await register()
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mark the registered fixture PTY as renderer-owned, matching the normal paired-terminal registration path.
      const ownership = runtime as unknown as { pairedRendererSessionOwnedPtyIds: Set<string> }
      ownership.pairedRendererSessionOwnedPtyIds.add('pty-existing')

      const first = await runtime.listMobileSessionTabs(`id:${ALIAS}`)
      expect(first.worktree).toBe(WORKTREE)
      expect(first.tabs).toContainEqual(expect.objectContaining({ ptyId: 'pty-existing' }))

      publishGraph(runtime)
      const published = await runtime.listMobileSessionTabs(`id:${ALIAS}`)
      expect(published.worktree).toBe(WORKTREE)
      expect(published.tabs).toContainEqual(expect.objectContaining({ id: TAB }))
    }
  )

  it('delivers a later canonical publication to an early alias subscriber without a false empty frame', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: unknown[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'sub-early',
        authToken: 'token',
        method: 'session.tabs.subscribe',
        params: { worktree: `id:${ALIAS}` }
      },
      (message) => messages.push(JSON.parse(message)),
      { connectionId: 'alias-connection' }
    )
    expect(messages).toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({ type: 'snapshot', worktree: ALIAS, tabs: [] })
      })
    )

    publishGraph(runtime)

    await vi.waitFor(() =>
      expect(messages).toContainEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            type: 'updated',
            worktree: WORKTREE,
            tabs: expect.arrayContaining([expect.objectContaining({ id: TAB })])
          })
        })
      )
    )
    expect(messages).not.toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({ type: 'updated', worktree: ALIAS, tabs: [] })
      })
    )
    runtime.cleanupSubscriptionsForConnection('alias-connection')
  })

  it.each([ALIAS, 'repo::g:/GIT/Example'])('lists the existing tabs for %s', async (alias) => {
    const runtime = liveRuntime()
    const original = await runtime.listMobileSessionTabs(`id:${WORKTREE}`)
    const listed = await runtime.listMobileSessionTabs(`id:${alias}`)

    expect(listed.worktree).toBe(WORKTREE)
    expect(listed.tabs).toEqual(original.tabs)
    expect(listed.tabs).toContainEqual(expect.objectContaining({ id: TAB }))
  })

  it('activates the existing terminal through the alias without spawning another process', async () => {
    const runtime = liveRuntime()
    const spawn = vi.fn()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const selected = await runtime.activateMobileSessionTab(`id:${ALIAS}`, TAB, undefined, {
      notifyClients: false
    })

    expect(selected.worktree).toBe(WORKTREE)
    expect(selected.activeTabId).toBe(TAB)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    { connectionId: undefined, persistedHostId: 'local', ownsSession: true },
    { connectionId: 'ssh-host', persistedHostId: 'ssh:ssh-host', ownsSession: true },
    { connectionId: undefined, persistedHostId: 'ssh:ssh-host', ownsSession: false },
    { connectionId: 'ssh-host', persistedHostId: 'local', ownsSession: false }
  ])(
    'resolves persisted tabs only in the owning partition: %j',
    async ({ connectionId, persistedHostId, ownsSession }) => {
      const repo = {
        id: 'repo',
        path: 'G:\\git\\example',
        displayName: 'example',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId
      }
      const session: WorkspaceSessionState = {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: {
          [WORKTREE]: [
            {
              id: 'tab',
              worktreeId: WORKTREE,
              ptyId: null,
              title: 'Existing conversation',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only repository and saved-session reads are reached; no process controller or filesystem scan is installed.
      const runtime = new OrcaRuntimeService({
        getRepo: (id: string) => (id === repo.id ? repo : undefined),
        getRepos: () => [repo],
        getWorkspaceSessionHostIds: () => ['local', 'ssh:ssh-host'],
        getWorkspaceSession: (hostId = 'local') =>
          hostId === persistedHostId ? session : getDefaultWorkspaceSession()
      } as never)

      const listed = await runtime.listMobileSessionTabs(`id:${ALIAS}`)

      expect(listed.worktree).toBe(ownsSession ? WORKTREE : ALIAS)
      if (ownsSession) {
        expect(listed.tabs).toContainEqual(
          expect.objectContaining({ title: 'Existing conversation' })
        )
      } else {
        expect(listed.tabs).toEqual([])
      }
    }
  )

  it('preserves an exact empty publication instead of adopting another spelling', async () => {
    const empty = { ...snapshot(ALIAS), activeTabId: null, activeTabType: null, tabs: [] }
    const runtime = liveRuntime(WORKTREE, [empty])
    const listed = await runtime.listMobileSessionTabs(`id:${ALIAS}`)
    expect(listed.worktree).toBe(ALIAS)
    expect(listed.tabs).toEqual([])
  })

  it('rejects an alias with multiple known spellings instead of choosing a session', async () => {
    const runtime = liveRuntime(WORKTREE, [snapshot(ALIAS)])
    await expect(runtime.listMobileSessionTabs('id:repo::g:/GIT/Example')).rejects.toThrow(
      'selector_ambiguous'
    )
  })

  it.each(['other-repo::G:/git/example', 'repo::G:/git/another'])(
    'keeps %s separate',
    async (other) => {
      const listed = await liveRuntime().listMobileSessionTabs(`id:${other}`)
      expect(listed.worktree).toBe(other)
      expect(listed.tabs).toEqual([])
    }
  )

  it('preserves independent folder-workspace instances in the same directory', async () => {
    const first = `${WORKTREE}::workspace:11111111-1111-4111-8111-111111111111`
    const second = `${ALIAS}::workspace:22222222-2222-4222-8222-222222222222`
    const runtime = liveRuntime(first)

    const listed = await runtime.listMobileSessionTabs(`id:${first.replaceAll('\\', '/')}`)
    expect(listed.worktree).toBe(first)
    expect(listed.tabs).toContainEqual(expect.objectContaining({ id: TAB }))
    expect((await runtime.listMobileSessionTabs(`id:${second}`)).tabs).toEqual([])
  })

  it('keeps POSIX paths case-sensitive', async () => {
    const runtime = liveRuntime('repo::/home/user/Project')
    const listed = await runtime.listMobileSessionTabs('id:repo::/home/user/project')
    expect(listed.tabs).toEqual([])
  })
})
