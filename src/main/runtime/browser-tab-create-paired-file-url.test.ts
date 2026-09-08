/**
 * A paired client reaches `browser.tabCreate` with a caller-supplied URL, and the page it creates is
 * streamed back over `browser.screencast`. Without a fence, `file:///…/id_rsa` renders any file on
 * the host into the caller's frames. The native HTML-artifact open is the same call, so the fence
 * has to be a workspace-root containment check rather than a scheme ban. "Paired" is every
 * authenticated paired socket — phone, web client, remote desktop, remote CLI — not just mobile.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { setRuntimeBrowserCommandsFactory } from './runtime-browser-commands-factory'
import { RpcDispatcher } from './rpc/dispatcher'
import { BROWSER_CORE_METHODS } from './rpc/methods/browser-core'

const { browserSessionRegistryMock } = vi.hoisted(() => ({
  browserSessionRegistryMock: {
    getDefaultProfile: () => ({
      id: 'default',
      partition: 'persist:orca-browser'
    }),
    getProfile: () => ({ id: 'default', partition: 'persist:orca-browser' }),
    resolveKnownPartition: () => 'persist:orca-browser'
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  webContents: { fromId: vi.fn() }
}))
vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: browserSessionRegistryMock
}))

const WORKTREE_PATH = '/tmp/worktree-a'
const WT = `repo-1::${WORKTREE_PATH}`

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

function makeSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: { [WT]: [] },
    terminalLayoutsByTabId: {}
  }
}

function createRuntime(worktree: { id: string; path?: string; hostId?: string }) {
  let session = makeSession()
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  })
  const createTab = vi.fn(async (options: { browserPageId?: string }) => ({
    browserPageId: options.browserPageId ?? 'page-new'
  }))
  const internals = runtime as unknown as {
    offscreenBrowserBackend: unknown
    agentBrowserBridge: unknown
    resolveWorktreeSelector: (selector: string) => Promise<typeof worktree>
  }
  internals.resolveWorktreeSelector = async () => worktree
  internals.offscreenBrowserBackend = { closeTab: vi.fn(), createTab }
  internals.agentBrowserBridge = {
    tabList: vi.fn(() => ({ tabs: [] })),
    getRegisteredTabs: vi.fn(() => new Map()),
    setActiveTab: vi.fn()
  }
  return { runtime, createTab }
}

function create(
  runtime: OrcaRuntimeService,
  url: string,
  caller?: { pairedDeviceId?: string; clientKind?: 'mobile' | 'runtime' }
): Promise<{ browserPageId: string }> {
  return runtime.browserTabCreate(
    {
      worktree: `id:${WT}`,
      page: 'page-new',
      url,
      activate: true,
      navigation: 'caller'
    },
    caller
  )
}

describe('browser.tabCreate file: URLs from a paired client', () => {
  beforeAll(async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host))
    return () => setRuntimeBrowserCommandsFactory(null)
  })

  beforeEach(() => {
    vi.useFakeTimers()
    return () => vi.useRealTimers()
  })

  it('refuses a paired file: create outside the named workspace and creates no page', async () => {
    const { runtime, createTab } = createRuntime({
      id: WT,
      path: WORKTREE_PATH
    })
    await expect(
      create(runtime, 'file:///tmp/secrets/id_rsa', {
        pairedDeviceId: 'device-1',
        clientKind: 'mobile'
      })
    ).rejects.toThrow(/outside the requested workspace/)
    expect(createTab).not.toHaveBeenCalled()
  })

  // Why: the shell-side confinement is page code; a paired client that is not this shell must still be fenced.
  it('refuses file:///etc/passwd dispatched over RPC by a paired mobile device', async () => {
    const { runtime, createTab } = createRuntime({
      id: WT,
      path: WORKTREE_PATH
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_CORE_METHODS })
    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'req-1',
        authToken: 'tok',
        method: 'browser.tabCreate',
        params: {
          worktree: `id:${WT}`,
          page: 'page-new',
          url: 'file:///etc/passwd',
          activate: true,
          navigation: 'caller'
        }
      },
      (reply) => replies.push(reply),
      { pairedDeviceId: 'device-1', clientKind: 'mobile' }
    )
    expect(JSON.parse(replies[0]!)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/outside the requested workspace/) }
    })
    expect(createTab).not.toHaveBeenCalled()
  })

  it('still opens an HTML artifact inside the workspace, the native file-tap feature', async () => {
    const { runtime, createTab } = createRuntime({
      id: WT,
      path: WORKTREE_PATH
    })
    await expect(
      create(runtime, `file://${WORKTREE_PATH}/build/report.html`, {
        pairedDeviceId: 'device-1',
        clientKind: 'mobile'
      })
    ).resolves.toEqual({ browserPageId: 'page-new' })
    expect(createTab).toHaveBeenCalledTimes(1)
  })

  it('refuses a paired file: create for an SSH workspace, whose path is on another machine', async () => {
    const { runtime, createTab } = createRuntime({
      id: WT,
      path: WORKTREE_PATH,
      hostId: 'ssh:box'
    })
    await expect(
      create(runtime, `file://${WORKTREE_PATH}/build/report.html`, {
        pairedDeviceId: 'device-1',
        clientKind: 'mobile'
      })
    ).rejects.toThrow(/remote workspace/)
    expect(createTab).not.toHaveBeenCalled()
  })

  // The gate is `caller.pairedDeviceId`, which `runtime-rpc-pairing.ts` mints for `scope: 'runtime'`
  // as well as `'mobile'`. So it also governs the web client, a desktop paired to a remote runtime,
  // and remote `orca browser tab create` — breadth as a decision, not a side effect.
  it('applies the same fence to a runtime-scope paired client, not only a phone', async () => {
    const { runtime, createTab } = createRuntime({ id: WT, path: WORKTREE_PATH })
    const caller = { pairedDeviceId: 'device-2', clientKind: 'runtime' as const }

    await expect(create(runtime, 'file:///tmp/secrets/id_rsa', caller)).rejects.toThrow(
      /outside the requested workspace/
    )
    expect(createTab).not.toHaveBeenCalled()

    await expect(
      create(runtime, `file://${WORKTREE_PATH}/build/report.html`, caller)
    ).resolves.toEqual({ browserPageId: 'page-new' })
    expect(createTab).toHaveBeenCalledTimes(1)
  })

  it('leaves an unpaired local create alone', async () => {
    const { runtime, createTab } = createRuntime({
      id: WT,
      path: WORKTREE_PATH
    })
    await expect(create(runtime, 'file:///tmp/secrets/id_rsa')).resolves.toEqual({
      browserPageId: 'page-new'
    })
    expect(createTab).toHaveBeenCalledTimes(1)
  })
})
