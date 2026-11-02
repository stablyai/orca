import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as VersionGc from '../managed-server/lifecycle/orcad-managed-version-gc'
import type * as RemoteVersionedInstall from '../managed-server/install/remote-versioned-install'

const mocks = vi.hoisted(() => ({
  installed: new Set<string>(),
  record: vi.fn(),
  readiness: vi.fn(),
  pins: vi.fn(),
  live: vi.fn(async () => false),
  remove: vi.fn()
}))

vi.mock('../managed-server/activation/orcad-activation-record-store', () => ({
  readOrcadActivationRecord: mocks.record
}))
vi.mock('../managed-server/lifecycle/orcad-managed-version-gc', async (importOriginal) => ({
  ...(await importOriginal<typeof VersionGc>()),
  probeOrcadSlotReadiness: mocks.readiness
}))
vi.mock('../ssh/orcad-gc-transaction-pins', () => ({ readOrcadGcTransactionPins: mocks.pins }))
vi.mock('../managed-server/install/orcad-remote-gc', () => ({ isOrcadInstallDirLive: mocks.live }))
vi.mock('../managed-server/install/remote-install-gc', () => ({
  removeRemoteInstallVersionDir: mocks.remove
}))
// The install itself runs for real against a host whose only state is which slots are complete.
vi.mock('../managed-server/install/remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteVersionedInstall>()),
  isRemoteInstallComplete: async (_conn: unknown, _model: unknown, dir: string) =>
    mocks.installed.has(dir),
  finalizeInstall: async (_conn: unknown, dir: string) => void mocks.installed.add(dir),
  abandonInstall: async () => true
}))
vi.mock('../managed-server/install/remote-install-lock', () => ({
  acquireInstallLock: vi.fn(async () => {})
}))
vi.mock('../managed-server/install/remote-install-transfers', () => ({
  uploadRemoteInstallDirectory: vi.fn(async () => {}),
  writeRemoteInstallFile: vi.fn(async () => {})
}))
vi.mock('../managed-server/install/orcad-remote-node-runtime', () => ({
  ensureRemoteOrcadNodeRuntime: vi.fn(async () => {})
}))
vi.mock('../ssh/remote-exec/remote-exec-command', () => ({
  execCommand: vi.fn(async () => ''),
  isUnconfirmedSshCommandTermination: () => false
}))

import { removeFailedFreshWslOrcadInstall } from './wsl-orcad-failed-install-removal'
import { installOrcadBundle } from '../managed-server/install/orcad-remote-install'
import { uploadRemoteInstallDirectory } from '../managed-server/install/remote-install-transfers'
import {
  emptyOrcadActivationRecord,
  withActivatedVersion
} from '../managed-server/activation/orcad-activation-record'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { OrcadDeployResult } from '../ssh/orcad-remote-deploy'

const NEW = '1.6.0+bb01'
const OLD = '1.5.0+aa01'
const NEW_DIR = `/home/u/.orca-remote/orcad-${NEW}`
const host = getRemoteHostPlatform('linux-x64')
const slot = {
  conn: Object.create(null),
  host,
  remoteHome: '/home/u',
  nodePath: '/usr/bin/node',
  userDataDir: '/home/u/.orca',
  bindHost: '127.0.0.1',
  port: 6768
}
const failedFresh: OrcadDeployResult = {
  outcome: 'installed-not-activated',
  fullVersion: NEW,
  code: 'orcad_activation_daemon_degraded',
  reason: 'the candidate failed its readiness check',
  startCheckFailed: true,
  freshlyInstalled: true
}

function install(): Promise<'uploaded' | 'reused'> {
  return installOrcadBundle(
    {
      ...slot,
      localOrcadDir: '/local/orcad',
      target: 'linux-x64-glibc',
      nodeRuntimeArchive: async () => '/cache/node.tar.gz'
    },
    NEW,
    NEW_DIR
  )
}

function daemon(state: 'live' | 'absent' | 'degraded', buildVersion = OLD) {
  return { health: { terminalDaemon: { state, buildVersion } } }
}

describe('removeFailedFreshWslOrcadInstall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.installed.clear()
    mocks.record.mockResolvedValue(
      withActivatedVersion(emptyOrcadActivationRecord(), OLD, null, new Date(0))
    )
    mocks.readiness.mockResolvedValue(daemon('live'))
    mocks.pins.mockResolvedValue({ state: 'pinned', dirNames: [] })
    mocks.remove.mockImplementation(async (_conn: unknown, _model: unknown, dir: string) =>
      mocks.installed.delete(dir)
    )
  })

  it('removes a slot this connect uploaded once its candidate fails, so the retry uploads again', async () => {
    expect(await install()).toBe('uploaded')

    await removeFailedFreshWslOrcadInstall(slot, failedFresh)

    expect(mocks.remove).toHaveBeenCalledWith(slot.conn, expect.anything(), NEW_DIR, host, {
      isDirLive: expect.any(Function)
    })
    expect(mocks.installed.has(NEW_DIR)).toBe(false)
    expect(await install()).toBe('uploaded')
    expect(uploadRemoteInstallDirectory).toHaveBeenCalledTimes(2)
  })

  it('also removes a failed first install, where nothing is active', async () => {
    mocks.record.mockResolvedValue(emptyOrcadActivationRecord())
    await install()

    await removeFailedFreshWslOrcadInstall(slot, failedFresh)

    expect(mocks.readiness).not.toHaveBeenCalled()
    expect(mocks.installed.has(NEW_DIR)).toBe(false)
  })

  it('never touches a slot that was already installed before this connect', async () => {
    mocks.installed.add(NEW_DIR)
    expect(await install()).toBe('reused')

    await removeFailedFreshWslOrcadInstall(slot, { ...failedFresh, freshlyInstalled: undefined })

    expect(mocks.record).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(await install()).toBe('reused')
  })

  it('keeps a deferred update staged for later', async () => {
    await removeFailedFreshWslOrcadInstall(slot, { ...failedFresh, startCheckFailed: undefined })
    await removeFailedFreshWslOrcadInstall(slot, { outcome: 'already-active', fullVersion: NEW })

    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it.each([
    [
      'is the active version',
      withActivatedVersion(emptyOrcadActivationRecord(), NEW, null, new Date(0))
    ],
    [
      'is the rollback target',
      withActivatedVersion(
        withActivatedVersion(emptyOrcadActivationRecord(), NEW, null, new Date(0)),
        OLD,
        null,
        new Date(1)
      )
    ]
  ])('never removes a slot that %s', async (_label, record) => {
    mocks.record.mockResolvedValue(record)

    await removeFailedFreshWslOrcadInstall(slot, failedFresh)

    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it.each([
    ['runs a live terminal daemon from it', daemon('live', NEW)],
    ['cannot name its terminal daemon build', daemon('degraded')]
  ])('keeps the slot while the serving version %s', async (_label, readiness) => {
    mocks.readiness.mockResolvedValue(readiness)

    await removeFailedFreshWslOrcadInstall(slot, failedFresh)

    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it.each([
    ['a held fence or unreadable journal', { state: 'keep-all' }],
    ['a journaled activation', { state: 'pinned', dirNames: [`orcad-${NEW}`] }]
  ])('keeps the slot that %s may still need', async (_label, pins) => {
    mocks.pins.mockResolvedValue(pins)

    await removeFailedFreshWslOrcadInstall(slot, failedFresh)

    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('leaves the failed connect to report its own reason when cleanup fails', async () => {
    mocks.readiness.mockRejectedValue(new Error('probe timed out'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(removeFailedFreshWslOrcadInstall(slot, failedFresh)).resolves.toBeUndefined()

    expect(mocks.remove).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
