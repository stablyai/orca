// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings, getDefaultUIState } from '../../../shared/constants'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import { TEST_LEAF_1 } from '../../../main/persistence/persistence-session-fixtures'
import {
  closeTestStores,
  createStore,
  readPersistedState,
  registerWorkspaceRepos,
  testState
} from '../../../main/persistence/persistence-test-harness'
import { createTestStore, seedStore } from '../store/testing/app-store-test-fixture'
import type { AppState } from '../store/types'
import { makeWorktree } from '../store/slices/worktrees/worktree.test-fixture'
import {
  buildWorkspaceSessionPayload,
  shouldPersistWorkspaceSession
} from '../lib/workspace/persistence/workspace-session'
import { createSessionWriteSubscriber } from '../lib/workspace/persistence/session-write-subscriber'
import {
  patchWorkspaceSessionByHost,
  persistWorkspaceSessionByHost
} from '../lib/workspace/persistence/workspace-session-host-persistence'
import { waitForFreshPaneStart } from '../components/terminal-pane/pty-connection/spawn/main-pane-start-wait'
import { useAppStartupHydration } from './use-app-startup-hydration'
import {
  admitUnseenStartupDestinations,
  expectUnseenDestinations,
  laterStartupDestination,
  LATER_LEAF,
  restoredStartupPane,
  savedStartupSession,
  WORKTREE
} from './startup-retained-save.test-fixture'

const stores = vi.hoisted(() => {
  let current: ReturnType<typeof createTestStore> | undefined
  return {
    set: (store: ReturnType<typeof createTestStore>) => {
      current = store
    },
    get: () => {
      if (!current) {
        throw new Error('startup test store missing')
      }
      return current
    }
  }
})
vi.mock('@/store/index', () => ({
  useAppStore: Object.assign(<T,>(selector: (state: AppState) => T) => stores.get()(selector), {
    getState: () => stores.get().getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      stores.get().setState(...args),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      stores.get().subscribe(...args)
  })
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../lib/agent-session/launch/structured-agent-session-launch-surface', () => ({
  restoreStructuredLaunchSurfaces: () => undefined
}))
vi.mock(
  '../components/terminal-pane/account-restart/detached/codex-detached-pane-restart-scheduler',
  () => ({ installCodexDetachedPaneRestartExecutor: () => () => undefined })
)
vi.mock('./native-chat-draft-startup', () => ({
  waitForNativeChatDraftsAtStartup: async () => undefined
}))
vi.mock('../lib/agent-session/accounts/codex/codex-stale-pane-sweep', () => ({
  sweepRestoredCodexPanesForStaleAccounts: () => undefined
}))
vi.mock('../runtime/native-chat/local-sessions/local-structured-chats', () => ({
  restoreLocalStructuredChatsAtStartup: async () => undefined
}))
vi.mock('../components/terminal-pane/appearance/terminal-appearance', () => ({
  publishTerminalViewAttributesAtAppStart: () => undefined
}))

let stopWriter: (() => void) | undefined
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  testState.dir = mkdtempSync(join(tmpdir(), 'sta14647-startup-save-'))
})
afterEach(async () => {
  stopWriter?.()
  stopWriter = undefined
  cleanup()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function fixture() {
  const host = createStore()
  registerWorkspaceRepos(host, WORKTREE)
  const initial = savedStartupSession()
  host.setWorkspaceSession(initial)
  const renderer = createTestStore()
  stores.set(renderer)
  const completed = Promise.withResolvers<void>()
  const preparing = Promise.withResolvers<void>()
  const response = Promise.withResolvers<unknown>()
  const prepare = vi.fn(async () => {
    preparing.resolve()
    return response.promise
  })
  const historyPath = join(testState.dir, 'terminal-history')
  seedStore(renderer, {
    settings: getDefaultSettings('/test-home'),
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/worktree', hostId: 'local' })]
    },
    fetchOrcaProfiles: async () => undefined,
    fetchSettings: async () => undefined,
    fetchKeybindings: async () => undefined,
    fetchReposForAllHosts: async () => undefined,
    awaitLocalRepoCatalogSettlement: async () => undefined,
    fetchProjectGroupsForAllHosts: async () => undefined,
    fetchFolderWorkspacesForAllHosts: async () => undefined,
    fetchWslMovedProjects: async () => undefined,
    seedReposFromHostCatalogSnapshots: async () => undefined,
    fetchAllWorktrees: async () => [],
    fetchWorktreeLineage: async () => undefined,
    awaitOwnerWorktreeVisibilityDefaultsHydration: async () => undefined,
    fetchBrowserSessionProfiles: async () => undefined,
    initGitHubCache: async () => {
      completed.resolve()
    }
  })
  vi.spyOn(renderer.getState(), 'fetchWorktrees').mockResolvedValue(true)
  const api = {
    get: async () => structuredClone(host.getWorkspaceSession()),
    patch: vi.fn(async (...args: Parameters<typeof host.patchWorkspaceSession>) => {
      host.patchWorkspaceSession(...args)
    }),
    set: async (...args: Parameters<typeof host.setWorkspaceSession>) => {
      host.setWorkspaceSession(...args)
    },
    flush: () => host.flushPendingOrThrowAsync()
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      session: api,
      onboarding: { get: async () => getDefaultOnboardingState() },
      ui: {
        get: async () => getDefaultUIState(),
        set: async () => undefined,
        getZoomLevel: () => 0,
        syncTrafficLights: () => undefined
      },
      runtime: { getStatus: async () => ({ capabilities: [] }) },
      runtimeEnvironments: { list: async () => [] },
      pty: {
        getGoneSessionIds: async () => [],
        getAuthoritativeBufferSnapshotCapabilities: async () => []
      },
      app: {
        prepareTerminalStartupRestoration: prepare,
        awaitGitEnvironmentStartupBarrier: async () => undefined,
        awaitFirstWindowStartupServices: async () => undefined,
        recoverLegacyWorkerTerminalsForRendererStartup: async () => undefined
      }
    }
  })
  stopWriter = createSessionWriteSubscriber({
    store: renderer,
    persist: ({ patch }) => patchWorkspaceSessionByHost(api, patch, renderer.getState()).written
  })
  return { host, renderer, initial, api, historyPath, preparing, response, completed }
}

it('completes actual startup with partial terminal facts and preserves unseen host destinations through ordinary patch and full export', async () => {
  const f = fixture()
  renderHook(() => useAppStartupHydration(() => undefined))
  await act(async () => {
    await f.preparing.promise
  })
  expect(f.renderer.getState().tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual([
    'renderer-tab',
    'later-tab'
  ])
  expect(shouldPersistWorkspaceSession(f.renderer.getState())).toBe(false)
  await admitUnseenStartupDestinations(f.host, f.historyPath)
  await act(async () => {
    f.response.resolve({ retainedTerminalStarts: [null, laterStartupDestination(f.initial)] })
    await f.completed.promise
  })
  expect(f.renderer.getState().hydrationSucceeded).toBe(true)
  expect(f.renderer.getState().terminalStartupRestorationReady).toBe(true)
  expect(shouldPersistWorkspaceSession(f.renderer.getState())).toBe(true)
  expect(
    f.renderer.getState().terminalPaneStartsByPaneKey[`later-tab:${LATER_LEAF}`]
  ).toMatchObject({
    status: 'failed',
    retainedTerminalStart: { tabId: 'later-tab', leafId: LATER_LEAF }
  })
  const held = restoredStartupPane(f.renderer)
  const waiting = waitForFreshPaneStart(held.session, null, {})
  expect(waiting).toBeInstanceOf(Promise)
  try {
    act(() => f.renderer.getState().setTabCustomLabel('browser-tab', 'My saved research'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    await f.host.flushPendingOrThrowAsync()
    await expectUnseenDestinations(f.historyPath)
    expect(
      readPersistedState().workspaceSession?.unifiedTabs?.[WORKTREE]?.find(
        (tab) => tab.id === 'browser-tab'
      )?.customLabel
    ).toBe('My saved research')
    const state = f.renderer.getState()
    const exported = buildWorkspaceSessionPayload(state)
    expect(exported.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual([
      'renderer-tab',
      'later-tab'
    ])
    expect(exported.terminalLayoutsByTabId['renderer-tab'].root).toEqual({
      type: 'leaf',
      leafId: TEST_LEAF_1
    })
    await persistWorkspaceSessionByHost(f.api, exported, state)
    await expectUnseenDestinations(f.historyPath)
    expect(
      readPersistedState().workspaceSession?.unifiedTabs?.[WORKTREE]?.find(
        (tab) => tab.id === 'browser-tab'
      )?.customLabel
    ).toBe('My saved research')
    expect(
      f.renderer.getState().terminalStartupAttempt?.isUnknown(WORKTREE, 'renderer-tab', TEST_LEAF_1)
    ).toBe(true)
    expect(held.startFreshSpawn).not.toHaveBeenCalled()
  } finally {
    held.session.disposed = true
    for (const dispose of held.session.waitTeardowns) {
      dispose()
    }
  }
  await expect(waiting).resolves.toBeNull()
})

it('keeps actual startup degraded and ordinary edits unsaved when the preparation service rejects', async () => {
  const f = fixture()
  renderHook(() => useAppStartupHydration(() => undefined))
  await act(async () => {
    await f.preparing.promise
  })
  await admitUnseenStartupDestinations(f.host, f.historyPath)
  await f.host.flushPendingOrThrowAsync()
  const before = readPersistedState().workspaceSession
  await act(async () => {
    f.response.reject(new Error('terminal startup service unavailable'))
    await f.completed.promise
  })
  expect(f.renderer.getState().workspaceSessionReady).toBe(true)
  expect(f.renderer.getState().terminalStartupRestorationReady).toBe(true)
  expect(f.renderer.getState().hydrationSucceeded).toBe(false)
  expect(shouldPersistWorkspaceSession(f.renderer.getState())).toBe(false)
  act(() => f.renderer.getState().setTabCustomLabel('browser-tab', 'Unsavable edit'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
  expect(f.api.patch).not.toHaveBeenCalled()
  await f.host.flushPendingOrThrowAsync()
  expect(readPersistedState().workspaceSession).toEqual(before)
  await expectUnseenDestinations(f.historyPath)
})
