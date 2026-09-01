import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAKE_DAEMON_ENTRY_PATH, FAKE_USER_DATA_PATH } from './daemon-init-test-harness'

const {
  forkMock,
  checkDaemonHealthMock,
  daemonClientMock,
  spawnerInstances,
  importFresh,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

const { canForkThroughUtilityMock, forkThroughUtilityMock, materializeRelocatedHostMock } =
  vi.hoisted(() => ({
    canForkThroughUtilityMock: vi.fn(() => false),
    forkThroughUtilityMock: vi.fn(),
    materializeRelocatedHostMock: vi.fn<() => { execPath: string; entryPath: string } | null>(
      () => null
    )
  }))

const RELOCATED_EXEC_PATH = 'C:\\fake\\localappdata\\daemon-host\\1.2.3\\Orca.exe'
const RELOCATED_ENTRY_PATH =
  'C:\\fake\\localappdata\\daemon-host\\1.2.3\\resources\\app.asar.unpacked\\out\\main\\daemon-entry.js'

vi.mock('fs', () => moduleFactories.fs())
vi.mock('child_process', async (importOriginal) =>
  moduleFactories.childProcess(await importOriginal<Record<string, unknown>>())
)
vi.mock('net', () => moduleFactories.net())
vi.mock('./daemon-health', () => moduleFactories.daemonHealth())
vi.mock('./daemon-pid-identity', () => moduleFactories.daemonPidIdentity())
vi.mock('./daemon-tcc-attribution', () => moduleFactories.daemonTccAttribution())
vi.mock('./daemon-bundle-staleness', () => moduleFactories.daemonBundleStaleness())
vi.mock('./daemon-stale-kill', () => moduleFactories.daemonStaleKill())
vi.mock('./daemon-process-start-time', () => moduleFactories.daemonProcessStartTime())
vi.mock('./daemon-pid-file-parse', () => moduleFactories.daemonPidFileParse())
vi.mock('./client', () => moduleFactories.client())
vi.mock('./daemon-lifecycle-event', () => moduleFactories.daemonLifecycleEvent())
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./daemon-utility-process-fork', () => ({
  canForkDaemonThroughUtilityProcess: canForkThroughUtilityMock,
  forkDaemonThroughUtilityProcess: forkThroughUtilityMock
}))
vi.mock('./daemon-host-relocation', () => ({
  materializeRelocatedDaemonHost: materializeRelocatedHostMock,
  collectPinnedDaemonVersions: () => new Set<string>(),
  pruneOldDaemonHosts: () => {}
}))

function fakeLaunchedChild(): {
  pid: number
  on(event: string, cb: (arg?: unknown) => void): unknown
  off(): unknown
  disconnect: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
} {
  return {
    pid: 12345,
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'message') {
        queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
      }
      return this
    },
    off() {
      return this
    },
    disconnect: vi.fn(),
    unref: vi.fn()
  }
}

/**
 * The harness's endpoint-identity reader derives the launch nonce from forkMock's
 * argv; the utility path never calls forkMock, so read it from the utility spec.
 */
function readAdoptionIdentityFromUtilitySpec(): void {
  daemonClientMock.mockImplementation(function MockUtilityAdoptionClient() {
    return {
      ensureConnected: vi.fn(async () => {}),
      getDaemonIdentity: vi.fn(() => {
        const spec = forkThroughUtilityMock.mock.calls.at(-1)?.[0] as { args: string[] } | undefined
        const nonceIndex = spec ? spec.args.indexOf('--launch-nonce') : -1
        return nonceIndex >= 0 && spec
          ? { pid: 12345, startedAtMs: 1_000_000, launchNonce: spec.args[nonceIndex + 1] }
          : null
      }),
      request: vi.fn(async () => ({ sessions: [] })),
      disconnect: vi.fn()
    }
  })
}

/** importFresh resets forkMock, so callers must queue fork results AFTER this. */
async function primeLauncher(): Promise<
  (socketPath: string, tokenPath: string) => Promise<unknown>
> {
  const mod = await importFresh()
  checkDaemonHealthMock.mockResolvedValue('unreachable')
  await mod.initDaemonPtyProvider()
  return spawnerInstances[0].launcher as (socketPath: string, tokenPath: string) => Promise<unknown>
}

describe('daemon-init: descriptor-clean daemon fork', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
    canForkThroughUtilityMock.mockReset()
    canForkThroughUtilityMock.mockReturnValue(false)
    forkThroughUtilityMock.mockReset()
    materializeRelocatedHostMock.mockReset()
    materializeRelocatedHostMock.mockReturnValue(null)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('forks through the utility-process launcher when it is available', async () => {
    const launcher = await primeLauncher()
    canForkThroughUtilityMock.mockReturnValue(true)
    forkThroughUtilityMock.mockImplementation(async () => fakeLaunchedChild())
    readAdoptionIdentityFromUtilitySpec()

    await launcher('/fake/socket', '/fake/token')

    expect(forkThroughUtilityMock).toHaveBeenCalledOnce()
    expect(forkMock).not.toHaveBeenCalled()
    const spec = forkThroughUtilityMock.mock.calls[0][0] as {
      entryPath: string
      args: string[]
      cwd: string
      env: NodeJS.ProcessEnv
      execPath: string
    }
    expect(spec.entryPath).toBe(FAKE_DAEMON_ENTRY_PATH)
    expect(spec.cwd).toBe(FAKE_USER_DATA_PATH)
    expect(spec.execPath).toBe(process.execPath)
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(spec.env.ORCA_USER_DATA_PATH).toBe(FAKE_USER_DATA_PATH)
    expect(spec.args).toEqual(
      expect.arrayContaining(['--socket', '/fake/socket', '--entry-path', FAKE_DAEMON_ENTRY_PATH])
    )
  })

  it('falls back to the direct fork when the utility launch fails, so the daemon still exists', async () => {
    const launcher = await primeLauncher()
    canForkThroughUtilityMock.mockReturnValue(true)
    forkThroughUtilityMock.mockRejectedValue(new Error('utility spawn refused'))
    forkMock.mockReturnValueOnce(fakeLaunchedChild())
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await launcher('/fake/socket', '/fake/token')
    } finally {
      warnSpy.mockRestore()
    }

    expect(forkThroughUtilityMock).toHaveBeenCalledOnce()
    expect(forkMock).toHaveBeenCalledOnce()
  })

  // Why: on Windows the daemon must run a byte-identical host staged outside the
  // updater's kill zone. Reverting either arm of the utility spec to the install-dir
  // values puts the daemon image back where the updater deletes it mid-run.
  it('forks the relocated host image and its mirrored entry, not the install-dir pair', async () => {
    const launcher = await primeLauncher()
    canForkThroughUtilityMock.mockReturnValue(true)
    materializeRelocatedHostMock.mockReturnValue({
      execPath: RELOCATED_EXEC_PATH,
      entryPath: RELOCATED_ENTRY_PATH
    })
    forkThroughUtilityMock.mockImplementation(async () => fakeLaunchedChild())
    readAdoptionIdentityFromUtilitySpec()

    await launcher('/fake/socket', '/fake/token')

    const spec = forkThroughUtilityMock.mock.calls[0][0] as {
      entryPath: string
      args: string[]
      execPath: string
    }
    expect(spec.execPath).toBe(RELOCATED_EXEC_PATH)
    expect(spec.entryPath).toBe(RELOCATED_ENTRY_PATH)
    // --entry-path stays the install-dir entry: it is the daemon's staleness identity.
    expect(spec.args[spec.args.indexOf('--entry-path') + 1]).toBe(FAKE_DAEMON_ENTRY_PATH)
  })

  it('keeps the direct fork where the utility hop is unavailable (macOS, plain-node hosts)', async () => {
    const launcher = await primeLauncher()
    canForkThroughUtilityMock.mockReturnValue(false)
    forkMock.mockReturnValueOnce(fakeLaunchedChild())

    await launcher('/fake/socket', '/fake/token')

    expect(forkThroughUtilityMock).not.toHaveBeenCalled()
    expect(forkMock).toHaveBeenCalledOnce()
  })
})
