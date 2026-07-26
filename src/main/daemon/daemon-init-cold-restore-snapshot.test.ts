import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { adapterInstances, importFresh, installDefaultNetConnectStub, moduleFactories } =
  await vi.hoisted(async () => (await import('./daemon-init-test-harness')).createDaemonInitMocks())

vi.mock('electron', () => moduleFactories.electron())
vi.mock('fs', () => moduleFactories.fs())
vi.mock('child_process', async (importOriginal) =>
  moduleFactories.childProcess(await importOriginal<Record<string, unknown>>())
)
vi.mock('net', () => moduleFactories.net())
vi.mock('./daemon-health', () => moduleFactories.daemonHealth())
vi.mock('./client', () => moduleFactories.client())
vi.mock('./daemon-lifecycle-event', () => moduleFactories.daemonLifecycleEvent())
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())

describe('readColdRestoreTerminalSnapshot', () => {
  type ColdRestoreStub = {
    hasPty: ReturnType<typeof vi.fn>
    readColdRestoreSnapshot: ReturnType<typeof vi.fn>
  }
  const frame = { snapshotAnsi: 'last frame' }

  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  /** Installs a router of current + legacy, both stubbed for the cold-restore lookup. */
  async function installStubbedRouter(): Promise<{
    mod: Awaited<ReturnType<typeof importFresh>>
    current: ColdRestoreStub
    legacy: ColdRestoreStub
  }> {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const { DaemonPtyRouter } = await import('./daemon-pty-router')
    const { DaemonPtyAdapter } = await import('./daemon-pty-adapter')
    const currentAdapter = adapterInstances[0]
    const legacyAdapter = new DaemonPtyAdapter({
      socketPath: '/fake/legacy.sock',
      tokenPath: '/fake/legacy.token',
      protocolVersion: 3
    })
    const stub = (target: unknown): ColdRestoreStub => {
      const entry = target as ColdRestoreStub
      entry.hasPty = vi.fn(() => false)
      entry.readColdRestoreSnapshot = vi.fn(async () => null)
      return entry
    }
    const current = stub(currentAdapter)
    const legacy = stub(legacyAdapter)
    mod.replaceDaemonProvider(
      new DaemonPtyRouter({
        current: currentAdapter as never,
        legacy: [legacyAdapter as never]
      }) as never
    )
    return { mod, current, legacy }
  }

  // Why: every adapter shares this profile's one history directory, so without
  // a guard above the loop a legacy adapter would answer for a session the
  // current adapter is still running — and the dashboard would tear that live
  // pane down and rebuild it read-only.
  it('refuses a history frame while any adapter still owns the session', async () => {
    const { mod, current, legacy } = await installStubbedRouter()
    current.hasPty.mockReturnValue(true)
    legacy.readColdRestoreSnapshot.mockResolvedValue(frame)

    await expect(mod.readColdRestoreTerminalSnapshot('live-session')).resolves.toBeNull()
    // Not merely null: the disk was never consulted for a live session.
    expect(legacy.readColdRestoreSnapshot).not.toHaveBeenCalled()
    expect(current.readColdRestoreSnapshot).not.toHaveBeenCalled()
  })

  it('falls through to a legacy adapter when no adapter owns the session', async () => {
    const { mod, legacy } = await installStubbedRouter()
    legacy.readColdRestoreSnapshot.mockResolvedValue(frame)

    await expect(
      mod.readColdRestoreTerminalSnapshot('rebooted', { scrollbackRows: 24 })
    ).resolves.toBe(frame)
    // The caller's bound has to survive the hop, or history returns whatever
    // the session ever wrote.
    expect(legacy.readColdRestoreSnapshot).toHaveBeenCalledWith('rebooted', {
      scrollbackRows: 24
    })
  })

  it('keeps searching when an adapter throws', async () => {
    const { mod, current, legacy } = await installStubbedRouter()
    current.readColdRestoreSnapshot.mockRejectedValue(new Error('history unreadable'))
    legacy.readColdRestoreSnapshot.mockResolvedValue(frame)

    await expect(mod.readColdRestoreTerminalSnapshot('rebooted')).resolves.toBe(frame)
  })
})
