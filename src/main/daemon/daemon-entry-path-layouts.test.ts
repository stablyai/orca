/**
 * Which daemon-entry.js the launcher forks, per deployment layout.
 *
 * The layout that matters here is orcad's: a packaged host with NO asar, whose bundle root
 * holds `orcad.js` and `daemon-entry.js` side by side (config/scripts/build-orcad.mjs emits
 * exactly that). Resolving against `out/main` there would fork a path that does not exist,
 * and the failure would surface as "terminals do not persist" rather than as a missing file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { FAKE_APP_PATH, FAKE_DAEMON_ENTRY_PATH } from './daemon-init-test-harness'

const {
  getAppPathMock,
  isPackagedMock,
  probeSocketExistsMock,
  forkMock,
  checkDaemonHealthMock,
  spawnerInstances,
  importFresh,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

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

const ASAR_APP_PATH = join('/packaged', 'resources', 'app.asar')
const ASAR_UNPACKED_ENTRY = join(
  '/packaged',
  'resources',
  'app.asar.unpacked',
  'out',
  'main',
  'daemon-entry.js'
)
const ORCAD_ROOT = join('/opt', 'orcad')
const ORCAD_ADJACENT_ENTRY = join(ORCAD_ROOT, 'daemon-entry.js')

/** Drive one launch under the given layout and return the entry path that was forked. */
async function forkedDaemonEntryPath(layout: {
  appPath: string
  isPackaged: boolean
  existingEntry?: string
}): Promise<string> {
  // Why after importFresh: it resets these mocks to their defaults on every fresh import.
  const mod = await importFresh()
  getAppPathMock.mockReturnValue(layout.appPath)
  isPackagedMock.mockReturnValue(layout.isPackaged)
  probeSocketExistsMock.mockImplementation((p?: string) => p === layout.existingEntry)
  checkDaemonHealthMock.mockResolvedValue('unreachable')
  await mod.initDaemonPtyProvider()
  const launcher = spawnerInstances[0].launcher as (
    socketPath: string,
    tokenPath: string
  ) => Promise<unknown>
  forkMock.mockImplementationOnce(() => {
    throw new Error('stop after entry resolution')
  })
  await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
    'stop after entry resolution'
  )
  return forkMock.mock.calls.at(-1)?.[0] as string
}

describe('daemon entry path per deployment layout', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('resolves the dev checkout entry under out/main', async () => {
    expect(await forkedDaemonEntryPath({ appPath: FAKE_APP_PATH, isPackaged: false })).toBe(
      FAKE_DAEMON_ENTRY_PATH
    )
  })

  it('redirects a packaged Electron asar root to app.asar.unpacked', async () => {
    expect(await forkedDaemonEntryPath({ appPath: ASAR_APP_PATH, isPackaged: true })).toBe(
      ASAR_UNPACKED_ENTRY
    )
  })

  it('forks the entry beside orcad.js on a packaged host with no asar', async () => {
    // orcad answers isPackaged() true; the question the resolver must ask is whether the app
    // root is an asar archive, not whether the build is packaged.
    expect(
      await forkedDaemonEntryPath({
        appPath: ORCAD_ROOT,
        isPackaged: true,
        existingEntry: ORCAD_ADJACENT_ENTRY
      })
    ).toBe(ORCAD_ADJACENT_ENTRY)
  })
})
