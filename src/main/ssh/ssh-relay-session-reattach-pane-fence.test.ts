/**
 * The superseded-PTY fence must be LIVE on the relay reattach path — the path it
 * was built for. Production wiring only: the real `pty:spawn`/`pty:write`
 * handlers from src/main/ipc/pty.ts and a real `SshRelaySession` whose reconnect
 * drives `restoreReattachedPtyRuntime`; only the wire below the provider is fake.
 *
 * Today reattach binds the pane through `runtime.registerPty` while spawn binds
 * through `rememberPaneKeyForPty`, so the fence maps never learn the successor
 * and a keystroke queued for the superseded PTY still reaches the host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
const listeners = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  BrowserWindow: undefined,
  app: {
    isPackaged: true,
    getPath: () => '/tmp/orca-reattach-fence-test',
    getVersion: () => '0.0.0-test'
  },
  powerMonitor: { on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    },
    on: (channel: string, listener: (event: unknown, args: unknown) => unknown) => {
      listeners.set(channel, listener)
    },
    removeHandler: (channel: string) => handlers.delete(channel),
    removeAllListeners: (channel: string) => listeners.delete(channel)
  }
}))

const { providerInstances, spawnedPtyIds, attachIncarnationId } = vi.hoisted(() => ({
  providerInstances: [] as unknown[],
  spawnedPtyIds: [] as string[],
  attachIncarnationId: 'incarnation-reattached'
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
vi.mock('./ssh-remote-orca-cli', () => ({
  runRemoteOrcaCli: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
}))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: vi.fn(
    async (_mux: unknown, options: { clientInstanceId: string }) => ({
      clientInstanceId: options.clientInstanceId,
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'test-owner-lease'
    })
  )
}))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    notify = vi.fn()
    notifyWithSettlement = vi.fn()
    request = vi.fn().mockResolvedValue([])
    onNotification = vi.fn().mockReturnValue(() => {})
    onNotificationByMethod = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)
  }
}))
vi.mock('../agent-hooks/remote-managed-hook-installers', () => ({
  installRemoteManagedAgentHooks: vi.fn()
}))
// The relay session constructs and registers this provider itself, so the real
// pty.ts registry hands the same instance to pty:spawn and pty:write.
vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: (error: unknown) => String(error).includes('not found'),
  isSshPtyIdentityMismatchError: (error: unknown) => String(error).includes('identity mismatch'),
  SshPtyProvider: class MockSshPtyProvider {
    spawn = vi.fn(async () => ({ id: spawnedPtyIds.shift() ?? 'ssh:target-1@@pty-unexpected' }))
    write = vi.fn()
    resize = vi.fn()
    shutdown = vi.fn()
    sendSignal = vi.fn()
    getCwd = vi.fn()
    getInitialCwd = vi.fn()
    clearBuffer = vi.fn()
    acknowledgeDataEvent = vi.fn()
    hasChildProcesses = vi.fn()
    getForegroundProcess = vi.fn()
    serialize = vi.fn()
    revive = vi.fn()
    listProcesses = vi.fn(async () => [])
    getDefaultShell = vi.fn()
    getProfiles = vi.fn()
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({ incarnationId: attachIncarnationId })
    dispose = vi.fn()

    constructor() {
      providerInstances.push(this)
    }
  }
}))
vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn().mockReturnValue({ dispose: vi.fn() })
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

const { SshRelaySession } = await import('./ssh-relay-session')
const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')
const {
  registerPtyHandlers,
  unregisterSshPtyProvider,
  getPtyIdForPaneKey,
  getPtyIdsForConnection,
  deletePtyOwnership
} = await import('../ipc/pty')

const TARGET = 'target-1'
const TAB_ID = 'tab-1'

type ProviderMock = { write: ReturnType<typeof vi.fn> }

function makeMainWindow() {
  const webContents = {
    id: 1,
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false
  }
  return { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents }
}

/** A live layout in which `leafId` sits in `tabId` — the tab the pane is in RIGHT NOW.
 *  The tab must also exist in `tabsByWorktree`: resolution ignores a layout whose tab is gone, so
 *  a fixture without one would resolve nothing and the clause would pass for the wrong reason. */
function sessionWithLeafInTab(tabId: string, leafId: string) {
  return {
    tabsByWorktree: { 'worktree-1': [{ id: tabId, worktreeId: 'worktree-1' }] },
    terminalLayoutsByTabId: {
      [tabId]: { root: { type: 'leaf' as const, leafId }, ptyIdsByLeafId: {} }
    }
  }
}

function makeStore(leases: unknown[], session?: ReturnType<typeof sessionWithLeafInTab>) {
  return {
    ...(session ? { getWorkspaceSession: vi.fn(() => session) } : {}),
    getRepos: vi.fn().mockReturnValue([]),
    getSshPtyConsumerRecovery: vi.fn().mockReturnValue(null),
    upsertSshPtyConsumerRecovery: vi.fn(),
    removeSshPtyConsumerRecovery: vi.fn(),
    getSshRemotePtyLeases: vi.fn(() => leases),
    supersedeDuplicatePaneLeases: vi.fn().mockReturnValue(0),
    markSshRemotePtyLease: vi.fn(),
    markSshRemotePtyLeases: vi.fn(),
    markSshRemotePtyLeasesAsync: vi.fn(),
    markSshRemotePtyLeasesForShutdown: vi.fn(),
    markSshRemotePtyLeasesAttachedAsync: vi.fn(),
    upsertSshRemotePtyLease: vi.fn(),
    persistPtyBinding: vi.fn().mockReturnValue(true)
  }
}

/**
 * One pane: spawned over SSH, then rebound by a reconnect whose durable lease
 * names a different remote PTY — the STA-3077 shape.
 */
async function spawnThenReattachPane(leafId: string, currentTabId?: string) {
  const mainWindow = makeMainWindow()
  const predecessorPtyId = `ssh:${TARGET}@@pty-old-${leafId.slice(0, 4)}`
  const reattachedRelayPtyId = `pty-new-${leafId.slice(0, 4)}`
  const leases: unknown[] = []
  const store = makeStore(
    leases,
    currentTabId ? sessionWithLeafInTab(currentTabId, leafId) : undefined
  )
  const runtime = { onPtySpawned: vi.fn(), registerPty: vi.fn() }
  const session = new SshRelaySession(
    TARGET,
    vi.fn().mockReturnValue(mainWindow) as never,
    store as never,
    { removeAllForwards: vi.fn() } as never,
    runtime as never
  )

  registerPtyHandlers(
    mainWindow as never,
    undefined,
    undefined,
    undefined,
    undefined,
    store as never
  )
  await session.establish({} as never)

  spawnedPtyIds.push(predecessorPtyId)
  await handlers.get('pty:spawn')!(null, {
    cols: 80,
    rows: 24,
    env: { ORCA_PANE_KEY: makePaneKey(TAB_ID, leafId) },
    connectionId: TARGET,
    worktreeId: 'worktree-1',
    tabId: TAB_ID,
    leafId
  })

  // The relay restarted; the pane's durable lease now names a different shell.
  leases.push({
    targetId: TARGET,
    ptyId: reattachedRelayPtyId,
    state: 'detached' as const,
    worktreeId: 'worktree-1',
    tabId: TAB_ID,
    leafId
  })
  await session.reconnect({} as never)
  // Reconnect builds a fresh provider; writes route through the live one.
  const provider = providerInstances.at(-1) as ProviderMock

  const write = (id: string): void => {
    listeners.get('pty:write')!({ sender: mainWindow.webContents }, { id, data: 'x' })
  }
  return {
    runtime,
    paneKey: makePaneKey(currentTabId ?? TAB_ID, leafId),
    predecessorPtyId,
    reattachedPtyId: `ssh:${TARGET}@@${reattachedRelayPtyId}`,
    provider,
    write,
    dispose: () => {
      deletePtyOwnership(predecessorPtyId)
      deletePtyOwnership(`ssh:${TARGET}@@${reattachedRelayPtyId}`)
      unregisterSshPtyProvider(TARGET)
    }
  }
}

describe('a relay reattach binds the pane through the same producer as spawn', () => {
  let cleanup: (() => void) | undefined

  beforeEach(() => {
    handlers.clear()
    listeners.clear()
    providerInstances.length = 0
    spawnedPtyIds.length = 0
    vi.mocked(deployAndLaunchRelay).mockResolvedValue({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      platform: 'linux-x64'
    } as never)
  })

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  it('refuses a queued write to the PTY the reattach superseded', async () => {
    const pane = await spawnThenReattachPane('11111111-1111-4111-8111-111111111111')
    cleanup = pane.dispose
    pane.provider.write.mockClear()
    // Still an owned, routable PTY — so only the fence can refuse the write.
    expect(getPtyIdsForConnection(TARGET)).toContain(pane.predecessorPtyId)

    // A keystroke the renderer queued before the reconnect, still addressed to
    // the shell the pane no longer owns.
    pane.write(pane.predecessorPtyId)
    await Promise.resolve()

    expect(pane.provider.write).not.toHaveBeenCalled()
  })

  it('resolves the pane to the reattached PTY', async () => {
    const pane = await spawnThenReattachPane('22222222-2222-4222-8222-222222222222')
    cleanup = pane.dispose

    expect(getPtyIdForPaneKey(pane.paneKey)).toBe(pane.reattachedPtyId)
  })

  // The lease's tabId is frozen at write time, but `detachTerminalPaneToTab` moves a live pane
  // into a new tab without killing its PTY. A producer that forwarded `lease.tabId` would key the
  // fence to the tab the pane LEFT — and every other clause here uses one tab on both sides, so
  // nothing else in this file would notice.
  it('keys the pane to the tab the leaf is in now, not the one its lease was written in', async () => {
    const leafId = '44444444-4444-4444-8444-444444444444'
    const pane = await spawnThenReattachPane(leafId, 'tab-moved-to')
    cleanup = pane.dispose

    expect(pane.paneKey).toBe(makePaneKey('tab-moved-to', leafId))
    expect(getPtyIdForPaneKey(pane.paneKey)).toBe(pane.reattachedPtyId)
    expect(getPtyIdForPaneKey(makePaneKey(TAB_ID, leafId))).not.toBe(pane.reattachedPtyId)
    // The runtime graph must land on the SAME tab as the record and the fence. Registering under
    // the lease's frozen tabId would split the pane across two tabs and ensure a mobile surface
    // for the one it left.
    expect(pane.runtime.registerPty).toHaveBeenCalledWith(
      pane.reattachedPtyId,
      'worktree-1',
      TARGET,
      expect.objectContaining({ tabId: 'tab-moved-to', leafId })
    )
  })

  // Guards the clause above from a fence that simply refuses everything.
  it('still delivers a write to the reattached PTY', async () => {
    const pane = await spawnThenReattachPane('33333333-3333-4333-8333-333333333333')
    cleanup = pane.dispose
    pane.provider.write.mockClear()

    pane.write(pane.reattachedPtyId)
    await Promise.resolve()

    expect(pane.provider.write).toHaveBeenCalledWith(pane.reattachedPtyId, 'x')
  })
})
