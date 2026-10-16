import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from './ssh-relay-exec-command'
import type * as RecordFile from './orcad-remote-record-file'
import type * as InstallLock from './ssh-relay-install-lock'
import type * as VersionedInstall from './remote-versioned-install'

vi.mock('./ssh-relay-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
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
vi.mock('./remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<typeof VersionedInstall>()),
  readLocalFullVersion: () => '0.2.0+bb01'
}))
vi.mock('./orcad-remote-install', () => ({ installOrcadBundle: vi.fn() }))
vi.mock('./orcad-remote-preflight', () => ({ preflightInstalledOrcad: vi.fn() }))
vi.mock('./orcad-local-build-hash', () => ({
  computeLocalOrcadBuildHash: () => 'abc123def4567890'
}))

import { execCommand } from './ssh-relay-exec-command'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { writeAtomicOrcadRemoteRecord } from './orcad-remote-record-file'
import { deployOrcad } from './orcad-remote-deploy'
import { recoverInterruptedOrcadActivation } from './orcad-activation-recovery'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { OrcadRestartAdmissionPort } from './orcad-restart-admission-client'
import { FakeOrcadHost, NEW, OLD } from './orcad-activation-host-test-harness'

let host = FakeOrcadHost.deployedOld()

const slot = {
  conn: Object.create(null),
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
const IDLE = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3, chatWork: 0 }

function admission(overrides: Partial<OrcadRestartAdmissionPort> = {}) {
  return { ...host.restartAdmission(OLD), release: vi.fn(async () => {}), ...overrides }
}

const update = (restartAdmission: OrcadRestartAdmissionPort, force?: boolean) =>
  deployOrcad({
    ...slot,
    localOrcadDir: '/local/out/orcad',
    target: 'linux-x64-glibc',
    census: IDLE,
    restartAdmission,
    ...(force ? { force } : {})
  })

const signaledIncumbent = (): boolean =>
  host.commands.some((command) => command.includes('kill -TERM') && command.includes(OLD))

beforeEach(() => {
  vi.clearAllMocks()
  host = FakeOrcadHost.deployedOld()
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
  vi.mocked(acquireInstallLock).mockImplementation(async (_conn, dir, _host, options) => {
    if (!host.acquireFence(options)) {
      const { RemoteInstallLockBusyError } = await vi.importActual<typeof InstallLock>(
        './ssh-relay-install-lock'
      )
      throw new RemoteInstallLockBusyError(dir, 0)
    }
  })
  vi.mocked(writeAtomicOrcadRemoteRecord).mockImplementation(async (_target, path, contents) =>
    host.write(path, contents)
  )
})

describe('an update over a serving incumbent', () => {
  it('lets the incumbent end itself after the journal, then activates', async () => {
    await expect(update(admission())).resolves.toMatchObject({
      outcome: 'installed-and-activated'
    })
    expect(host.activeVersion()).toBe(NEW)
    expect(signaledIncumbent()).toBe(false)
  })

  // Q5: work that started during the upload, or a chat still owed, keeps the old server.
  it.each([
    [{ liveSessions: 1, startedSinceActivation: 1 }, false, 'orcad_update_terminals_running'],
    [{ chatWork: 1 }, true, 'orcad_update_chat_work_running']
  ] as const)('defers on the reservation census %j (force %s)', async (fresh, force, code) => {
    const restart = admission({
      reserve: async () => ({ status: 'reserved', token: 't', census: { ...IDLE, ...fresh } })
    })
    await expect(update(restart, force)).resolves.toMatchObject({ code })
    expect(restart.release).toHaveBeenCalledWith('t')
    expect([...host.alive]).toEqual([OLD])
    expect(host.journal).toBeNull()
    expect(host.fence).toBe(false)
  })

  // Q5: a Send that wins the race against the commit runs on the retained old server.
  it('keeps serving an incumbent whose commit new work refused, unsignaled', async () => {
    const restart = admission({ commit: async () => 'refused' })
    await expect(update(restart)).resolves.toMatchObject({
      code: 'orcad_update_restart_not_reserved'
    })
    expect(restart.release).toHaveBeenCalled()
    expect([...host.alive]).toEqual([OLD])
    expect(host.journal).toBeNull()
    expect(host.fence).toBe(false)
    expect(signaledIncumbent()).toBe(false)
  })

  it('leaves a lost commit to recovery, which keeps the still-serving incumbent', async () => {
    const restart = admission({ commit: async () => 'unknown' })
    await expect(update(restart)).resolves.toMatchObject({
      code: 'orcad_outgoing_stop_incomplete'
    })
    expect(restart.release).toHaveBeenCalled()
    expect(host.fence).toBe(true)
    const recovered = await recoverInterruptedOrcadActivation(slot)
    expect(['recovered', 'none']).toContain(recovered.outcome)
    expect([...host.alive]).toEqual([OLD])
    expect(host.activeVersion()).toBe(OLD)
    expect(host.fence).toBe(false)
    expect(signaledIncumbent()).toBe(false)
  })

  it('bootstraps an older host only with Force and fresh proof it lacks admission', async () => {
    const census = { ...IDLE, chatWork: undefined, restartAdmissionSupported: false }
    const options = {
      ...slot, localOrcadDir: '/local/out/orcad', target: 'linux-x64-glibc' as const, census
    }
    await expect(deployOrcad(options)).resolves.toMatchObject({ code: 'orcad_update_legacy_host' })
    await expect(deployOrcad({ ...options, force: true, recountCensus: async () => IDLE }))
      .resolves.toMatchObject({ code: 'orcad_update_restart_not_reserved' })
    expect(signaledIncumbent()).toBe(false)
    await expect(deployOrcad({ ...options, force: true, recountCensus: async () => census }))
      .resolves.toMatchObject({ outcome: 'installed-and-activated' })
    expect(signaledIncumbent()).toBe(true)
    expect(host.activeVersion()).toBe(NEW)
  })
})
