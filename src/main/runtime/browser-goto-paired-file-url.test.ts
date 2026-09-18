/**
 * `browser.goto` is on the mobile allowlist and `normalizeBrowserNavigationUrl` permits `file:`,
 * so a paired client that creates an in-workspace tab could then navigate it to any host file and
 * read it out of the screencast. The create fence alone does not cover that second hop.
 */
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { setRuntimeBrowserCommandsFactory } from './runtime-browser-commands-factory'
import { RpcDispatcher } from './rpc/dispatcher'
import { BROWSER_CORE_METHODS } from './rpc/methods/browser-core'

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: {
    getDefaultProfile: () => ({ id: 'default', partition: 'persist:orca-browser' }),
    getProfile: () => ({ id: 'default', partition: 'persist:orca-browser' }),
    resolveKnownPartition: () => 'persist:orca-browser'
  }
}))
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

let WORKTREE_PATH = ''
let WT = ''
let ARTIFACT_URL = ''
let OUTSIDE_SECRET_URL = ''
let ESCAPE_LINK_URL = ''

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

const STARTING_URL = 'https://example.com/start'

function createRuntime(input: { id: string; path?: string; hostId?: string }) {
  // Production stamps hostId on every resolveWorktreeSelector exit; the guard refuses without it.
  const worktree = { hostId: 'local', ...input }
  let session: WorkspaceSessionState = {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: { [WT]: [] },
    terminalLayoutsByTabId: {}
  }
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  })
  let pageUrl = STARTING_URL
  const goto = vi.fn(async (url: string) => {
    pageUrl = url
    return { url, title: 'page' }
  })
  const internals = runtime as unknown as {
    agentBrowserBridge: unknown
    offscreenBrowserBackend: unknown
    resolveWorktreeSelector: (selector: string) => Promise<typeof worktree>
  }
  internals.resolveWorktreeSelector = async () => worktree
  internals.offscreenBrowserBackend = {
    closeTab: vi.fn(),
    createTab: vi.fn(async (options: { browserPageId?: string }) => ({
      browserPageId: options.browserPageId ?? 'page-1'
    }))
  }
  internals.agentBrowserBridge = {
    goto,
    getActivePageId: vi.fn(() => 'page-1'),
    getPageInfo: vi.fn(() => ({ browserPageId: 'page-1', url: pageUrl, title: 'page' })),
    getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]])),
    setActiveTab: vi.fn()
  }
  return { runtime, goto, currentUrl: () => pageUrl }
}

function goto(
  runtime: OrcaRuntimeService,
  url: string,
  caller?: { pairedDeviceId?: string; clientKind?: 'mobile' | 'runtime' }
): Promise<unknown> {
  return runtime.browserGoto({ worktree: `id:${WT}`, page: 'page-1', url }, caller)
}

beforeAll(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-goto-')))
  WORKTREE_PATH = path.join(base, 'worktree-a')
  WT = `repo-1::${WORKTREE_PATH}`
  await mkdir(path.join(WORKTREE_PATH, 'build'), { recursive: true })
  await mkdir(path.join(base, 'secrets'), { recursive: true })
  await writeFile(path.join(WORKTREE_PATH, 'build', 'report.html'), '<h1>artifact</h1>')
  await writeFile(path.join(base, 'secrets', 'id_rsa'), 'secret')
  ARTIFACT_URL = pathToFileURL(path.join(WORKTREE_PATH, 'build', 'report.html')).toString()
  OUTSIDE_SECRET_URL = pathToFileURL(path.join(base, 'secrets', 'id_rsa')).toString()
  await symlink(path.join(base, 'secrets', 'id_rsa'), path.join(WORKTREE_PATH, 'escape-link'))
  ESCAPE_LINK_URL = pathToFileURL(path.join(WORKTREE_PATH, 'escape-link')).toString()
  const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
  setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host))
  return () => setRuntimeBrowserCommandsFactory(null)
})

describe('browser.goto file: URLs from a paired client', () => {
  it('refuses a paired goto outside the workspace and leaves the page where it was', async () => {
    const { runtime, goto: bridgeGoto, currentUrl } = createRuntime({ id: WT, path: WORKTREE_PATH })
    await expect(
      goto(runtime, OUTSIDE_SECRET_URL, { pairedDeviceId: 'device-1', clientKind: 'mobile' })
    ).rejects.toThrow(/outside the requested workspace/)
    expect(bridgeGoto).not.toHaveBeenCalled()
    expect(currentUrl()).toBe(STARTING_URL)
  })

  // Why: the create fence is a different method; a paired client that is not this shell must be
  // fenced on the navigation hop too, dispatched the way a phone actually reaches it.
  it('refuses an outside file: goto dispatched over RPC by a paired mobile device', async () => {
    const { runtime, goto: bridgeGoto } = createRuntime({ id: WT, path: WORKTREE_PATH })
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_CORE_METHODS })
    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'req-1',
        authToken: 'tok',
        method: 'browser.goto',
        params: { worktree: `id:${WT}`, page: 'page-1', url: OUTSIDE_SECRET_URL }
      },
      (reply) => replies.push(reply),
      { pairedDeviceId: 'device-1', clientKind: 'mobile' }
    )
    expect(JSON.parse(replies[0]!)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/outside the requested workspace/) }
    })
    expect(bridgeGoto).not.toHaveBeenCalled()
  })

  it('still navigates to an HTML artifact inside the workspace', async () => {
    const { runtime, goto: bridgeGoto } = createRuntime({ id: WT, path: WORKTREE_PATH })
    await expect(
      goto(runtime, ARTIFACT_URL, { pairedDeviceId: 'device-1', clientKind: 'mobile' })
    ).resolves.toMatchObject({ url: ARTIFACT_URL })
    expect(bridgeGoto).toHaveBeenCalledTimes(1)
  })

  it('refuses a paired file: goto for an SSH workspace, whose path is on another machine', async () => {
    const { runtime, goto: bridgeGoto } = createRuntime({
      id: WT,
      path: WORKTREE_PATH,
      hostId: 'ssh:box'
    })
    await expect(
      goto(runtime, ARTIFACT_URL, { pairedDeviceId: 'device-1', clientKind: 'mobile' })
    ).rejects.toThrow(/remote workspace/)
    expect(bridgeGoto).not.toHaveBeenCalled()
  })

  it('refuses a paired file: goto that names no workspace to confine it to', async () => {
    const { runtime, goto: bridgeGoto } = createRuntime({ id: WT, path: WORKTREE_PATH })
    await expect(
      runtime.browserGoto(
        { page: 'page-1', url: OUTSIDE_SECRET_URL },
        { pairedDeviceId: 'device-1', clientKind: 'mobile' }
      )
    ).rejects.toThrow(/requires an explicit workspace/)
    expect(bridgeGoto).not.toHaveBeenCalled()
  })

  it('applies the same fence to a runtime-scope paired client, not only a phone', async () => {
    const { runtime, goto: bridgeGoto } = createRuntime({ id: WT, path: WORKTREE_PATH })
    const caller = { pairedDeviceId: 'device-2', clientKind: 'runtime' as const }
    await expect(goto(runtime, OUTSIDE_SECRET_URL, caller)).rejects.toThrow(
      /outside the requested workspace/
    )
    expect(bridgeGoto).not.toHaveBeenCalled()
    await expect(goto(runtime, ARTIFACT_URL, caller)).resolves.toMatchObject({ url: ARTIFACT_URL })
  })

  // The review's live P0, as a test: tabCreate about:blank returns early from the fence, then
  // goto carries the file: URL. Both hops must be fenced or the create fence proves nothing.
  it('refuses the create-blank-then-navigate sequence that read /etc/hosts on the old build', async () => {
    const { runtime, goto: bridgeGoto, currentUrl } = createRuntime({ id: WT, path: WORKTREE_PATH })
    const caller = { pairedDeviceId: 'device-1', clientKind: 'mobile' as const }
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_CORE_METHODS })

    const created = await runtime.browserTabCreate(
      { worktree: `id:${WT}`, page: 'page-1', url: 'about:blank', activate: true },
      caller
    )
    expect(created).toMatchObject({ browserPageId: 'page-1' })

    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'req-p0',
        authToken: 'tok',
        method: 'browser.goto',
        params: { worktree: `id:${WT}`, page: 'page-1', url: 'file:///etc/hosts' }
      },
      (reply) => replies.push(reply),
      caller
    )
    expect(JSON.parse(replies[0]!)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    expect(bridgeGoto).not.toHaveBeenCalled()
    expect(currentUrl()).toBe(STARTING_URL)
  })

  it('refuses a percent-encoded separator traversal on the navigation hop', async () => {
    const { runtime, goto: bridgeGoto } = createRuntime({ id: WT, path: WORKTREE_PATH })
    const url = `${pathToFileURL(WORKTREE_PATH).toString()}%2f..%2fsecrets%2fid_rsa`
    await expect(
      goto(runtime, url, { pairedDeviceId: 'device-1', clientKind: 'mobile' })
    ).rejects.toThrow(/outside the requested workspace/)
    expect(bridgeGoto).not.toHaveBeenCalled()
  })

  it('refuses a symlink inside the workspace that points outside it', async () => {
    const { runtime, goto: bridgeGoto } = createRuntime({ id: WT, path: WORKTREE_PATH })
    await expect(
      goto(runtime, ESCAPE_LINK_URL, { pairedDeviceId: 'device-1', clientKind: 'mobile' })
    ).rejects.toThrow(/outside the requested workspace/)
    expect(bridgeGoto).not.toHaveBeenCalled()
  })

  it('leaves http(s) and unpaired local gotos alone', async () => {
    const { runtime, goto: bridgeGoto } = createRuntime({ id: WT, path: WORKTREE_PATH })
    await expect(
      goto(runtime, 'https://example.com/next', {
        pairedDeviceId: 'device-1',
        clientKind: 'mobile'
      })
    ).resolves.toMatchObject({ url: 'https://example.com/next' })
    await expect(goto(runtime, OUTSIDE_SECRET_URL)).resolves.toMatchObject({
      url: OUTSIDE_SECRET_URL
    })
    expect(bridgeGoto).toHaveBeenCalledTimes(2)
  })
})
