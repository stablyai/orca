import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'
import type * as RecordFile from './orcad-remote-record-file'
import type * as InstallLock from './ssh-relay-install-lock'
import type * as VersionedInstall from './ssh-relay-versioned-install'

vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployHelpers>()),
  execCommand: vi.fn()
}))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))
vi.mock('./ssh-relay-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn()
}))
vi.mock('./orcad-remote-record-file', async (importOriginal) => ({
  ...(await importOriginal<typeof RecordFile>()),
  writeAtomicOrcadRemoteRecord: vi.fn()
}))
vi.mock('./ssh-relay-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<typeof VersionedInstall>()),
  readLocalFullVersion: () => '0.2.0+bb01'
}))
vi.mock('./orcad-remote-install', () => ({ installOrcadBundle: vi.fn() }))
vi.mock('./orcad-remote-preflight', () => ({ preflightInstalledOrcad: vi.fn() }))
vi.mock('./orcad-local-build-hash', () => ({
  computeLocalOrcadBuildHash: () => 'abc123def4567890'
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { writeAtomicOrcadRemoteRecord } from './orcad-remote-record-file'
import { deployOrcad } from './orcad-remote-deploy'
import { rollbackOrcad } from './orcad-remote-rollback'
import { recoverInterruptedOrcadActivation } from './orcad-activation-recovery'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'
import {
  BUILD_HASH,
  FakeOrcadHost,
  NEW,
  OLD,
  type CrashMode
} from './orcad-activation-host-test-harness'

let host = new FakeOrcadHost()

const slot = {
  conn: {} as SshConnection,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/u',
  nodePath: '/usr/bin/node',
  userDataDir: '/home/u/.orca',
  bindHost: '127.0.0.1',
  port: 7777,
  readinessTimeoutMs: 50,
  sleep: async () => {},
  now: () => new Date('2026-02-02T00:00:00.000Z')
}
const census = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 }

const deploy = (): Promise<unknown> =>
  deployOrcad({ ...slot, localOrcadDir: '/local/out/orcad', target: 'linux-x64-glibc', census })
const rollback = (): Promise<unknown> =>
  rollbackOrcad({
    ...slot,
    record: FakeOrcadHost.newRecord(),
    census,
    targetBuildHash: BUILD_HASH,
    targetDaemonProtocol: { protocolVersion: 3, previousProtocolVersions: [1, 2] },
    terminalsStartedSince: async () => 0
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
  vi.mocked(acquireInstallLock).mockImplementation(async () => host.acquireFence())
  vi.mocked(writeAtomicOrcadRemoteRecord).mockImplementation(async (_target, path, contents) =>
    host.write(path, contents)
  )
})

/** The invariant: the host serves exactly the slot its record names, on state that slot reads. */
function expectExactlyTheRecordedSlot(): void {
  const active = host.activeVersion()
  expect([...host.alive]).toEqual(active ? [active] : [])
  expect(host.isReadableBy(active)).toBe(true)
  expect(host.journal).toBeNull()
  expect(host.fence).toBe(false)
}

/** Unconfirmed termination never deletes a slot directory or a snapshot. */
function expectNoSlotOrSnapshotRemoved(): void {
  const removals = host.commands.filter((command) => /\brm -r?f\b/u.test(command))
  for (const command of removals) {
    // A file inside a slot (a consumed stop request) may go; the slot directory never does.
    expect(command).not.toMatch(/rm -r?f '[^']*\/orcad-\d[^'/]*\/?'/u)
    expect(command).not.toMatch(/rm -r?f '[^']*orcad-state-snapshots/u)
  }
}

function countMutations(
  scenario: () => FakeOrcadHost,
  run: () => Promise<unknown>
): Promise<number> {
  host = scenario()
  return run().then(() => host.mutations)
}

const scenarios: [string, () => FakeOrcadHost, () => Promise<unknown>][] = [
  ['an update over an incumbent', FakeOrcadHost.deployedOld, deploy],
  ['a first activation', () => new FakeOrcadHost(), deploy],
  ['a rollback', FakeOrcadHost.activatedNew, rollback]
]

describe.each(scenarios)('%s interrupted at every mutation', (_name, scenario, run) => {
  it('completes cleanly when nothing interrupts it', async () => {
    host = scenario()
    await run()
    expectExactlyTheRecordedSlot()
    expect(host.activeVersion()).toBe(run === rollback ? OLD : NEW)
  })

  it.each<CrashMode>(['before', 'after'])(
    'recovers to exactly one recorded slot when the host answer is lost %s applying it',
    async (mode) => {
      const total = await countMutations(scenario, run)
      expect(total).toBeGreaterThan(3)
      for (let crashAt = 1; crashAt <= total; crashAt += 1) {
        host = scenario()
        host.crashAt = crashAt
        host.crashMode = mode
        await run().catch(() => undefined)
        host.crashAt = null
        const result = await recoverInterruptedOrcadActivation({
          ...slot,
          terminalsStartedSince: async () => 0
        })
        expect(['recovered', 'none'], `mutation ${crashAt}`).toContain(result.outcome)
        expectExactlyTheRecordedSlot()
        expectNoSlotOrSnapshotRemoved()
      }
    }
  )
})

describe('recovery refusals keep the fence', () => {
  async function interruptedAfterCandidateLaunch(): Promise<void> {
    host = FakeOrcadHost.deployedOld()
    const total = await countMutations(FakeOrcadHost.deployedOld, deploy)
    host = FakeOrcadHost.deployedOld()
    // The last three mutations are: candidate-ready journal, record, fence release.
    host.crashAt = total - 2
    host.crashMode = 'before'
    await deploy().catch(() => undefined)
    host.crashAt = null
    expect(host.alive.has(NEW)).toBe(true)
  }

  it('does not restore state over terminals started since the interrupted change', async () => {
    await interruptedAfterCandidateLaunch()
    const result = await recoverInterruptedOrcadActivation({
      ...slot,
      terminalsStartedSince: async () => 2
    })
    expect(result).toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_recovery_orphans_live_terminals'
    })
    expect(host.fence).toBe(true)
    expect(host.journal).not.toBeNull()
    expect(host.alive.size).toBe(0)
  })

  it.each([undefined, null])('keeps changed state when the fresh census is %s', async (started) => {
    await interruptedAfterCandidateLaunch()
    const result = await recoverInterruptedOrcadActivation({
      ...slot,
      ...(started === undefined ? {} : { terminalsStartedSince: async () => started })
    })
    expect(result).toMatchObject({ outcome: 'refused', code: 'orcad_recovery_census_required' })
    expect(host.journal).not.toBeNull()
  })

  it('never treats an unverifiable incumbent as exited', async () => {
    host = FakeOrcadHost.deployedOld()
    host.crashAt = 3
    await deploy().catch(() => undefined)
    host.crashAt = null
    host.pidFiles.delete(OLD)
    host.alive.delete(OLD)
    const result = await recoverInterruptedOrcadActivation({ ...slot })
    expect(result).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expect(host.fence).toBe(true)
    expect(host.alive.size).toBe(0)
  })

  it('reports a fresh fence as pending instead of taking it over', async () => {
    host = FakeOrcadHost.deployedOld()
    host.crashAt = 3
    await deploy().catch(() => undefined)
    host.crashAt = null
    const journal = host.journal
    expect(journal).not.toBeNull()
    const { RemoteInstallLockBusyError } = await vi.importActual<typeof InstallLock>(
      './ssh-relay-install-lock'
    )
    vi.mocked(acquireInstallLock).mockRejectedValueOnce(new RemoteInstallLockBusyError('/l', 0))
    expect(await recoverInterruptedOrcadActivation({ ...slot })).toMatchObject({
      outcome: 'pending'
    })
    expect(host.journal).toBe(journal)
  })

  it('keeps a journal this client cannot read', async () => {
    host = FakeOrcadHost.deployedOld()
    host.journal = JSON.stringify({ schemaVersion: 1, operation: 'decommission' })
    host.fence = true
    expect(await recoverInterruptedOrcadActivation({ ...slot })).toMatchObject({
      outcome: 'refused',
      code: 'orcad_recovery_unverifiable'
    })
    expect(host.fence).toBe(true)
  })

  it('drops a fence whose release was cut short after the journal went', async () => {
    host = FakeOrcadHost.deployedOld()
    host.fence = true
    expect(await recoverInterruptedOrcadActivation({ ...slot })).toEqual({ outcome: 'none' })
    expect(host.fence).toBe(false)
  })
})
