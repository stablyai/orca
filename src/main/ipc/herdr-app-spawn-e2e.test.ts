import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Store } from '../persistence'

type NodeFsModule = typeof nodeFs

// Why: the fs mock spreads the real module plus this helper so the socket
// readiness wait can poll the real filesystem instead of the always-true mock.
const realExistsSync = (nodeFs as unknown as { realExistsSync?: (path: string) => boolean })
  .realExistsSync!

// ── Mocks: mirror the app boundary the handler crosses, keep node-pty real ──
const mocks = vi.hoisted(() => {
  const state = { testUserData: '' }
  const getPathMock = vi.fn((name: string) => {
    if (name === 'userData') {
      return state.testUserData
    }
    return `${tmpdir()}/orca-${name}`
  })
  return {
    state,
    getPathMock,
    handleMock: vi.fn(),
    onMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    removeAllListenersMock: vi.fn(),
    registerPtyMock: vi.fn(),
    unregisterPtyMock: vi.fn(),
    recordCodexPaneAccountMock: vi.fn(),
    forgetCodexPaneAccountMock: vi.fn(),
    getCodexPaneAccountMock: vi.fn(),
    setMigrationUnsupportedPtyMock: vi.fn(),
    clearMigrationUnsupportedPtyMock: vi.fn(),
    clearMigrationUnsupportedPtysForPaneKeyMock: vi.fn(),
    ensureCodexBackfillRecoveryMock: vi.fn(async () => {}),
    existsSyncMock: vi.fn(() => true),
    statSyncMock: vi.fn(() => ({ size: 0 })),
    accessSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    readFileSyncMock: vi.fn(() => ''),
    writeFileSyncMock: vi.fn(),
    chmodSyncMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: undefined,
  app: {
    isPackaged: false,
    getPath: mocks.getPathMock,
    getVersion: () => '0.0.0-e2e'
  },
  powerMonitor: { on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
  ipcMain: {
    handle: mocks.handleMock,
    on: mocks.onMock,
    removeHandler: mocks.removeHandlerMock,
    removeAllListeners: mocks.removeAllListenersMock
  }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<NodeFsModule>()
  return {
    ...actual,
    realExistsSync: actual.existsSync,
    existsSync: mocks.existsSyncMock,
    statSync: mocks.statSyncMock,
    accessSync: mocks.accessSyncMock,
    mkdirSync: mocks.mkdirSyncMock,
    readFileSync: mocks.readFileSyncMock,
    writeFileSync: mocks.writeFileSyncMock,
    chmodSync: mocks.chmodSyncMock
  }
})

vi.mock('../cli/linux-terminal-orca-cli-shim', () => ({
  ensureLinuxTerminalOrcaCliShimDir: () => join(tmpdir(), 'orca-linux-shim')
}))

vi.mock('../memory/pty-registry', () => ({
  registerPty: mocks.registerPtyMock,
  unregisterPty: mocks.unregisterPtyMock
}))

vi.mock('../agent-hooks/migration-unsupported-pty-state', () => ({
  setMigrationUnsupportedPty: mocks.setMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPty: mocks.clearMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtysForPaneKey: mocks.clearMigrationUnsupportedPtysForPaneKeyMock
}))

vi.mock('../codex/codex-pane-account-registry', () => ({
  recordCodexPaneAccount: mocks.recordCodexPaneAccountMock,
  forgetCodexPaneAccount: mocks.forgetCodexPaneAccountMock,
  getCodexPaneAccount: mocks.getCodexPaneAccountMock
}))

vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  ensureCodexStateDbBackfillRecoveryStarted: mocks.ensureCodexBackfillRecoveryMock
}))

import { getLocalPtyProvider, registerPtyHandlers, setHerdrStore, setLocalPtyProvider } from './pty'
import { createLocalHerdrPtyProvider } from '../providers/multiplexer/herdr/herdr-provider-factory'

// Why: certifies the full app path with the herdr backend selected — the real
// registerPtyHandlers spawn handler, the herdr provider installed exactly the
// way daemon-init installs it, the real daemon child process, and a real login
// shell. XDG_RUNTIME_DIR/HOME are redirected so the test never touches the
// user's daemon socket or session state.
describe('herdr backend through the app pty:spawn handler (production path)', () => {
  const originalHome = process.env.HOME
  const originalXdg = process.env.XDG_RUNTIME_DIR
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  let dir = ''
  let socketPath = ''
  let daemon: ChildProcess | null = null

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  async function setup(): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'herdr-app-spawn-e2e-'))
    socketPath = join(dir, 'herdr-daemon.sock')
    mocks.state.testUserData = join(dir, 'user-data')
    mocks.existsSyncMock.mockImplementation(() => true)
    const childEnv = {
      ...process.env,
      HOME: dir,
      XDG_RUNTIME_DIR: dir,
      ORCA_APP_VERSION: 'e2e'
    }
    daemon = spawn(process.execPath, ['out/main/herdr-daemon-entry.js', 'daemon'], {
      env: childEnv,
      stdio: 'ignore'
    })
    process.env.HOME = dir
    process.env.XDG_RUNTIME_DIR = dir
    const deadline = Date.now() + 15_000
    while (!realExistsSync(socketPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!realExistsSync(socketPath)) {
      throw new Error('daemon socket did not appear')
    }

    const store = {
      getSettings: () => ({
        terminalBackendDefault: 'herdr',
        terminalScopeHistoryByWorktree: false,
        enableGitHubAttribution: false,
        agentStatusHooksEnabled: false
      }),
      getProjects: () => [],
      getRepo: () => undefined,
      getWorktreeMeta: () => undefined,
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} }),
      persistPtyBinding: vi.fn(() => true),
      upsertSshRemotePtyLease: vi.fn(),
      markSshRemotePtyLease: vi.fn()
    } as unknown as Store

    setHerdrStore(store)
    const herdrProvider = createLocalHerdrPtyProvider(undefined, store)
    setLocalPtyProvider(herdrProvider)

    const mainWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
    }
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      () => null,
      () => store.getSettings(),
      async () => ({
        configDir: join(tmpdir(), 'claude-config'),
        runtime: 'host',
        envPatch: {},
        stripAuthEnv: false,
        provenance: 'e2e'
      }),
      store
    )
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.XDG_RUNTIME_DIR = originalXdg
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    daemon?.kill('SIGTERM')
    daemon = null
    mocks.handleMock.mockReset()
    mocks.onMock.mockReset()
    mocks.removeHandlerMock.mockReset()
    mocks.removeAllListenersMock.mockReset()
    mocks.registerPtyMock.mockReset()
    mocks.recordCodexPaneAccountMock.mockReset()
    mocks.forgetCodexPaneAccountMock.mockReset()
    mocks.getCodexPaneAccountMock.mockReset()
    mocks.setMigrationUnsupportedPtyMock.mockReset()
    mocks.clearMigrationUnsupportedPtyMock.mockReset()
    mocks.clearMigrationUnsupportedPtysForPaneKeyMock.mockReset()
    mocks.ensureCodexBackfillRecoveryMock.mockReset()
    mocks.getPathMock.mockClear()
    mocks.existsSyncMock.mockClear()
    mocks.statSyncMock.mockClear()
    mocks.accessSyncMock.mockClear()
    mocks.mkdirSyncMock.mockClear()
    mocks.readFileSyncMock.mockClear()
    mocks.writeFileSyncMock.mockClear()
    mocks.chmodSyncMock.mockClear()
  })

  it('spawns a live herdr terminal through the real app handler and echoes input', async () => {
    await setup()

    const spawnHandler = mocks.handleMock.mock.calls.find(
      ([channel]) => channel === 'pty:spawn'
    )?.[1] as (event: null, args: Record<string, unknown>) => Promise<{ id: string }>

    expect(spawnHandler).toBeDefined()

    const result = await spawnHandler(null, {
      cols: 100,
      rows: 40,
      cwd: dir,
      worktreeId: `repo-1::${dir}`,
      tabId: 'tab-1',
      leafId: '22222222-2222-4222-8222-222222222222'
    })
    expect(result.id).toBeTruthy()
    expect(mocks.registerPtyMock).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: result.id })
    )

    const provider = getLocalPtyProvider()!

    provider.write(result.id, 'echo HERDR_APP_SPAWN_E2E\r')

    const deadline = Date.now() + 10_000
    let snapshot: string | null = null
    while (Date.now() < deadline) {
      const buffer = await provider.getBufferSnapshot?.(result.id, { scrollbackRows: 500 })
      if (buffer && buffer.data.includes('HERDR_APP_SPAWN_E2E')) {
        snapshot = buffer.data
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(snapshot).toBeTruthy()
    expect(snapshot).toContain('HERDR_APP_SPAWN_E2E')

    await provider.shutdown(result.id, {})
  })
})
