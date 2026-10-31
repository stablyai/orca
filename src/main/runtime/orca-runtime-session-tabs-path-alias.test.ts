import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { toRemoteRuntimePtyId } from '../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { bindPaneFirst } from './bind-first-pane.test-fixture'
import { partialRuntimeStore, storeRepo } from './runtime-store-partial-fixture'

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

function snapshot(
  worktree = WORKTREE,
  ptyId = 'pty-existing',
  binding: 'direct' | 'layout' = 'direct'
): RuntimeMobileSessionTabsSnapshot {
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
        ptyId: binding === 'layout' ? null : ptyId,
        ...(binding === 'layout'
          ? {
              parentLayout: {
                root: { type: 'leaf' as const, leafId: LEAF },
                activeLeafId: LEAF,
                expandedLeafId: null,
                ptyIdsByLeafId: { [LEAF]: ptyId }
              }
            }
          : {}),
        title: 'Existing conversation',
        isActive: true
      }
    ]
  }
}

/** Keep renderer authority so alias tests cannot pass through saved-session hydration. */
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
  additionalSnapshots: RuntimeMobileSessionTabsSnapshot[] = [],
  ptyId = 'pty-existing',
  binding: 'direct' | 'layout' = 'direct'
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
        ptyId,
        paneTitle: 'Existing conversation'
      }
    ],
    mobileSessionTabs: [snapshot(worktree, ptyId, binding), ...additionalSnapshots]
  })
}

function registerBoundPty(
  runtime: OrcaRuntimeService,
  ptyId: string,
  connectionId: string | null,
  repo: { connectionId?: string | null; executionHostId?: string | null } = {}
): void {
  bindPaneFirst(
    runtime,
    { worktreeId: WORKTREE, tabId: 'tab', leafId: LEAF, ptyId },
    getRepoExecutionHostId(repo)
  )
  runtime.registerPty(ptyId, WORKTREE, connectionId, { tabId: 'tab', leafId: LEAF })
}

describe('session tab workspace path aliases', () => {
  it.each(
    [
      { connectionId: undefined, ptyConnectionId: 'ssh-host', ownsSession: false },
      { connectionId: 'ssh-host', ptyConnectionId: undefined, ownsSession: false },
      { connectionId: 'ssh-host', ptyConnectionId: 'other-ssh-host', ownsSession: false },
      { connectionId: undefined, ptyConnectionId: undefined, ownsSession: true },
      { connectionId: 'ssh-host', ptyConnectionId: 'ssh-host', ownsSession: true }
    ].flatMap((entry) =>
      (['direct', 'layout', 'unpublished'] as const).map((binding) => ({ ...entry, binding }))
    )
  )(
    'keeps live alias adoption within the execution host: %j',
    async ({ connectionId, ptyConnectionId, ownsSession, binding }) => {
      const repo = storeRepo({ id: 'repo', path: 'G:\\git\\example', connectionId })
      const runtime = new OrcaRuntimeService(
        partialRuntimeStore({
          getRepo: () => repo,
          getRepos: () => [repo]
        })
      )
      runtime.attachWindow(1)
      const ptyId = ptyConnectionId
        ? toAppSshPtyId(ptyConnectionId, 'pty-existing')
        : 'pty-existing'
      registerBoundPty(runtime, ptyId, ptyConnectionId ?? null, repo)
      if (binding !== 'unpublished') {
        publishGraph(runtime, WORKTREE, [], ptyId, binding)
      } else {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: model a surviving renderer-owned PTY before its graph has arrived.
        const ownership = runtime as unknown as { pairedRendererSessionOwnedPtyIds: Set<string> }
        ownership.pairedRendererSessionOwnedPtyIds.add(ptyId)
      }

      if (ownsSession) {
        const listed = await runtime.listMobileSessionTabs(`id:${ALIAS}`)
        expect(listed.worktree).toBe(WORKTREE)
        expect(listed.tabs).toContainEqual(
          expect.objectContaining({
            id: TAB,
            ...(binding === 'layout'
              ? { parentLayout: expect.objectContaining({ ptyIdsByLeafId: { [LEAF]: ptyId } }) }
              : { ptyId })
          })
        )
      } else {
        await expect(runtime.listMobileSessionTabs(`id:${ALIAS}`)).rejects.toThrow(
          'worktree_execution_host_unresolved'
        )
        await expect(runtime.activateMobileSessionTab(`id:${ALIAS}`, TAB)).rejects.toThrow(
          'worktree_execution_host_unresolved'
        )
      }
    }
  )

  it.each(
    [
      { ptyId: toRemoteRuntimePtyId('term_1', 'env-a'), ownsSession: true },
      { ptyId: toRemoteRuntimePtyId('term_1', 'env-b'), ownsSession: false },
      { ptyId: toAppSshPtyId('nested-target', 'pty-1'), ownsSession: false },
      { ptyId: toAppSshPtyId('other-target', 'pty-1'), ownsSession: false },
      { ptyId: 'term_1', ownsSession: true }
    ].flatMap((entry) =>
      (['direct', 'layout', 'unpublished'] as const).map((binding) => ({ ...entry, binding }))
    )
  )(
    'keeps runtime aliases in the owning environment without trusting nested SSH names: %j',
    async ({ ptyId, ownsSession, binding }) => {
      const repo = storeRepo({
        id: 'repo',
        path: 'G:\\git\\example',
        executionHostId: 'runtime:env-a',
        connectionId: 'nested-target'
      })
      const runtime = new OrcaRuntimeService(
        partialRuntimeStore({
          getRepo: () => repo,
          getRepos: () => [repo]
        })
      )
      runtime.attachWindow(1)
      runtime.registerPty(ptyId, WORKTREE, null, { tabId: 'tab', leafId: LEAF })
      if (binding !== 'unpublished') {
        publishGraph(runtime, WORKTREE, [], ptyId, binding)
      } else {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exercise the existing surviving-renderer path before a graph publication.
        const ownership = runtime as unknown as { pairedRendererSessionOwnedPtyIds: Set<string> }
        ownership.pairedRendererSessionOwnedPtyIds.add(ptyId)
      }
      if (ownsSession) {
        const listed = await runtime.listMobileSessionTabs(`id:${ALIAS}`)
        expect(listed.worktree).toBe(WORKTREE)
        if (ORCA_LAYOUT_OWNER_IS_MAIN && binding === 'unpublished') {
          // Server-owned terminals cannot be rescued from this desktop's local registry.
          expect(listed.tabs).not.toContainEqual(expect.objectContaining({ id: TAB }))
        } else {
          expect(listed.tabs).toContainEqual(expect.objectContaining({ id: TAB }))
        }
      } else {
        await expect(runtime.listMobileSessionTabs(`id:${ALIAS}`)).rejects.toThrow(
          'worktree_execution_host_unresolved'
        )
        await expect(runtime.activateMobileSessionTab(`id:${ALIAS}`, TAB)).rejects.toThrow(
          'worktree_execution_host_unresolved'
        )
      }
    }
  )

  it('refuses alias adoption when repository rows disagree about the execution host', async () => {
    const local = storeRepo({ id: 'repo', path: 'G:\\git\\example' })
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getRepo: () => local,
        getRepos: () => [local, { ...local, connectionId: 'ssh-host' }]
      })
    )
    runtime.attachWindow(1)
    publishGraph(runtime)
    await expect(runtime.listMobileSessionTabs(`id:${ALIAS}`)).rejects.toThrow(
      'worktree_execution_host_unresolved'
    )
  })

  it.each([WORKTREE, ALIAS])(
    'activates %s when its renderer publishes during refresh',
    async (requested) => {
      const runtime = new OrcaRuntimeService()
      runtime.attachWindow(1)
      vi.spyOn(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publish through the real graph API at the asynchronous inventory boundary.
        runtime as unknown as { refreshMobileSessionPtyRecords: () => Promise<void> },
        'refreshMobileSessionPtyRecords'
      ).mockImplementation(async () => {
        publishGraph(runtime)
      })

      const selected = await runtime.activateMobileSessionTab(`id:${requested}`, TAB, undefined, {
        notifyClients: false
      })
      expect(selected.worktree).toBe(WORKTREE)
      expect(selected.activeTabId).toBe(TAB)
    }
  )

  it.each([false, true])(
    'recovers a surviving renderer PTY without pinning an empty alias (discovered during refresh: %s)',
    async (duringRefresh) => {
      // Why a store: main's layout binds the surviving pane in the store's workspace session.
      const runtime = new OrcaRuntimeService(partialRuntimeStore({ getRepos: () => [] }))
      runtime.attachWindow(1)
      const register = async () => {
        registerBoundPty(runtime, 'pty-existing', null)
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
            worktree: ALIAS,
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

  // Stream frames must use one workspace spelling or clients split tabs across alias keys.
  it('names an early alias subscriber stream by one spelling for its whole life', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const frames: { type?: string; worktree?: string; tabs?: unknown[] }[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'sub-early',
        authToken: 'token',
        method: 'session.tabs.subscribe',
        params: { worktree: `id:${ALIAS}` }
      },
      (message) => {
        const result = JSON.parse(message).result
        if (result?.type === 'snapshot' || result?.type === 'updated') {
          frames.push(result)
        }
      },
      { connectionId: 'alias-connection' }
    )

    publishGraph(runtime)

    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'updated')).toBe(true))
    expect(frames.map((frame) => frame.worktree)).toEqual(frames.map(() => ALIAS))
    expect(frames.at(-1)?.tabs).toContainEqual(expect.objectContaining({ id: TAB }))
    runtime.cleanupSubscriptionsForConnection('alias-connection')
  })

  it.each([
    [WORKTREE, ALIAS],
    [ALIAS, WORKTREE],
    [WORKTREE, 'repo::g:/GIT/Example'],
    ['repo::/srv/project', 'repo::/srv/project/'],
    ['repo::/srv/project', 'repo::/srv//project'],
    ['repo::/Users/dev/프로젝트', 'repo::/Users/dev/프로젝트'.normalize('NFD')],
    ['repo::\\\\wsl$\\Ubuntu\\home\\dev\\project', 'repo:://wsl.localhost/ubuntu/home/dev/project']
  ])('lists the existing tabs for %s via %s', async (worktree, alias) => {
    const runtime = liveRuntime(worktree)
    const original = await runtime.listMobileSessionTabs(`id:${worktree}`)
    const listed = await runtime.listMobileSessionTabs(`id:${alias}`)

    expect(listed.worktree).toBe(worktree)
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
      const runtime = new OrcaRuntimeService(
        partialRuntimeStore({
          getRepo: (id: string) => (id === repo.id ? repo : undefined),
          getRepos: () => [repo],
          getWorkspaceSessionHostIds: () => ['local', 'ssh:ssh-host'],
          getWorkspaceSession: (hostId = 'local') =>
            hostId === persistedHostId ? session : getDefaultWorkspaceSession()
        })
      )

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

  it('keeps a live PTY spelling exact instead of rewriting it to a published alias', () => {
    const runtime = liveRuntime(ALIAS)
    runtime.registerPty('pty-headless', WORKTREE, null)
    expect(runtime.getExplicitSessionWorktreeIdSelector(`id:${WORKTREE}`)).toBe(WORKTREE)
  })

  it('refuses alias adoption of an unattributed remote PTY for a local repository', async () => {
    const repo = storeRepo({ id: 'repo', path: 'G:\\git\\example' })
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({ getRepo: () => repo, getRepos: () => [repo] })
    )
    runtime.attachWindow(1)
    publishGraph(runtime, WORKTREE, [], toRemoteRuntimePtyId('term_1'))
    await expect(runtime.listMobileSessionTabs(`id:${ALIAS}`)).rejects.toThrow(
      'worktree_execution_host_unresolved'
    )
  })

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
