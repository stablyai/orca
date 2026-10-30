/** Paired browser creates must select only the screens named by their navigation target. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_NAVIGATION_TARGETS,
  type RuntimeNavigationTarget
} from '../../shared/runtime-navigation'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { setRuntimeBrowserCommandsFactory } from './runtime-browser-commands-factory'

const { browserSessionRegistryMock } = vi.hoisted(() => ({
  browserSessionRegistryMock: {
    getDefaultProfile: () => ({ id: 'default', partition: 'persist:orca-browser' }),
    getProfile: () => ({ id: 'default', partition: 'persist:orca-browser' }),
    resolveKnownPartition: () => 'persist:orca-browser'
  }
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn() }
}))
vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: browserSessionRegistryMock
}))

const WT = 'repo-1::/tmp/worktree-a'

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

type RuntimeInternals = {
  offscreenBrowserBackend: unknown
  agentBrowserBridge: unknown
  resolveGitWorktreeSelector: (selector: string) => Promise<{ id: string }>
}

function makeSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {
      [WT]: [
        {
          id: 'terminal-tab',
          ptyId: 'repo-1::wt@@abc',
          worktreeId: WT,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {}
  }
}

function createPairedRuntime() {
  let session = makeSession()
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  })
  const internals = runtime as unknown as RuntimeInternals
  // Stub git selector resolution; this contract needs only the resolved workspace id.
  internals.resolveGitWorktreeSelector = async () => ({ id: WT })
  internals.offscreenBrowserBackend = {
    closeTab: vi.fn(),
    ownsTab: () => true,
    createTab: vi.fn(async (options: { browserPageId?: string }) => ({
      browserPageId: options.browserPageId ?? 'page-new'
    }))
  }
  internals.agentBrowserBridge = {
    tabList: vi.fn(() => ({
      tabs: [
        {
          browserPageId: 'page-old',
          index: 0,
          url: 'https://old.test',
          title: 'Old',
          active: true
        },
        {
          browserPageId: 'page-alt',
          index: 1,
          url: 'https://alt.test',
          title: 'Alt',
          active: false
        },
        { browserPageId: 'page-new', index: 2, url: 'about:blank', title: 'New', active: false }
      ]
    })),
    getRegisteredTabs: vi.fn(() => new Map()),
    setActiveTab: vi.fn()
  }
  const caller: RuntimeMobileSessionTabsResult[] = []
  const bystander: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => caller.push(snapshot), 'device-caller')
  runtime.onMobileSessionTabsChanged((snapshot) => bystander.push(snapshot), 'device-bystander')
  // Shared host selection and the bystander's private projection can be stolen independently.
  const sharedActiveTabId = (): string | null | undefined =>
    (
      runtime as unknown as {
        getMobileSessionTabsForWorktree: (id: string) => RuntimeMobileSessionTabsResult
      }
    ).getMobileSessionTabsForWorktree(WT).activeTabId
  return { runtime, caller, bystander, sharedActiveTabId }
}

/** Seed distinct nonempty host/bystander selections so neither absence assertion can pass vacuously. */
async function seedSelections(runtime: OrcaRuntimeService): Promise<void> {
  await runtime.browserTabCreate({ worktree: `id:${WT}`, page: 'page-old', activate: true })
  await runtime.browserTabCreate({ worktree: `id:${WT}`, page: 'page-alt', activate: false })
  await runtime.activateMobileSessionTab(`id:${WT}`, 'page-alt', undefined, {
    navigation: 'caller',
    clientNavigationId: 'device-bystander'
  })
}

/** Cover all schema targets, including host/clients even when no first-party caller sends them. */
const CREATE_NAVIGATION_OUTCOMES = {
  caller: { shared: 'page-old', caller: 'page-new', bystander: 'page-alt' },
  host: { shared: 'page-new', caller: 'page-new', bystander: 'page-alt' },
  clients: { shared: 'page-old', caller: 'page-new', bystander: 'page-new' },
  all: { shared: 'page-new', caller: 'page-new', bystander: 'page-new' }
} satisfies Record<RuntimeNavigationTarget, { shared: string; caller: string; bystander: string }>

function createBrowserTab(
  runtime: OrcaRuntimeService,
  params: { navigation?: RuntimeNavigationTarget } = {}
): Promise<{ browserPageId: string }> {
  return runtime.browserTabCreate(
    {
      worktree: `id:${WT}`,
      page: 'page-new',
      url: 'about:blank',
      activate: true,
      ...(params.navigation ? { navigation: params.navigation } : {})
    },
    { pairedDeviceId: 'device-caller', clientKind: 'runtime' }
  )
}

describe('browser.tabCreate caller navigation', () => {
  beforeAll(async () => {
    // Install browser RPCs as Electron does; plain Node hosts leave them unavailable.
    const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
    setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host))
    return () => setRuntimeBrowserCommandsFactory(null)
  })

  beforeEach(() => {
    vi.useFakeTimers()
    return () => vi.useRealTimers()
  })

  it.each(RUNTIME_NAVIGATION_TARGETS)(
    'moves only the screens a %s create addresses',
    async (navigation) => {
      const expected = CREATE_NAVIGATION_OUTCOMES[navigation]
      const { runtime, caller, bystander, sharedActiveTabId } = createPairedRuntime()
      await seedSelections(runtime)
      expect(sharedActiveTabId()).toBe('page-old')
      expect(bystander.at(-1)?.activeTabId).toBe('page-alt')

      await createBrowserTab(runtime, { navigation })
      vi.advanceTimersByTime(300)

      expect(sharedActiveTabId()).toBe(expected.shared)
      expect(caller.at(-1)?.activeTabId).toBe(expected.caller)
      expect(bystander.at(-1)?.activeTabId).toBe(expected.bystander)
    }
  )

  it('defaults an origin-less paired create to caller-local selection', async () => {
    const { runtime, caller, bystander, sharedActiveTabId } = createPairedRuntime()
    await seedSelections(runtime)

    // An older client cannot send `navigation`; clientKind is what keeps its create local.
    await createBrowserTab(runtime)
    vi.advanceTimersByTime(300)

    expect(sharedActiveTabId()).toBe('page-old')
    expect(bystander.at(-1)?.activeTabId).toBe('page-alt')
    expect(caller.at(-1)?.activeTabId).toBe('page-new')
  })

  it('leaves paired devices where they were when the host creates a tab locally', async () => {
    const { runtime, bystander, sharedActiveTabId } = createPairedRuntime()
    await seedSelections(runtime)

    // A local create must not steer paired devices.
    await runtime.browserTabCreate({
      worktree: `id:${WT}`,
      page: 'page-new',
      url: 'about:blank',
      activate: true
    })
    vi.advanceTimersByTime(300)

    expect(sharedActiveTabId()).toBe('page-new')
    expect(bystander.at(-1)?.activeTabId).toBe('page-alt')
  })

  it('leaves a background create unselected on every device', async () => {
    const { runtime, caller, bystander, sharedActiveTabId } = createPairedRuntime()
    await seedSelections(runtime)

    await runtime.browserTabCreate(
      { worktree: `id:${WT}`, page: 'page-new', url: 'about:blank', navigation: 'caller' },
      { pairedDeviceId: 'device-caller', clientKind: 'runtime' }
    )
    vi.advanceTimersByTime(300)

    expect(caller.at(-1)?.activeTabId).not.toBe('page-new')
    expect(bystander.at(-1)?.activeTabId).toBe('page-alt')
    expect(sharedActiveTabId()).toBe('page-old')
  })
})
