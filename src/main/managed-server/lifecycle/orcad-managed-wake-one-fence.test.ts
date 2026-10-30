// WSL's same-version connect decides and starts under one activation fence.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import type * as InstallLock from '../install/remote-install-lock'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('../../../shared/shell-argument-quoting', () => ({
  quotePosixShell: (s: string) => `'${s}'`
}))
vi.mock('../install/remote-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn()
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { acquireInstallLock, RemoteInstallLockBusyError } from '../install/remote-install-lock'
import { wakeExpectedOrcadUnderOneFence, wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { FakeOrcadHost, NEW, OLD } from '../activation/orcad-activation-host-test-harness'

let host = new FakeOrcadHost()
/** Each command with whether this run held the fence when it ran; `acquire` marks acquisition. */
let trail: { command: string; fenced: boolean }[] = []

function transportFor(id: string): OrcadHostTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked; the wake reads only the target id.
  return { getTarget: () => ({ id }) } as unknown as OrcadHostTransport
}

const slot = {
  conn: transportFor('wsl:u'),
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/u',
  nodePath: '/usr/bin/node',
  userDataDir: '/home/u/.orca',
  bindHost: '127.0.0.1',
  port: 7777,
  readinessTimeoutMs: 50,
  sleep: async () => {}
}

const launches = () => trail.filter((step) => step.command.includes('nohup'))
const GUARD = /^\[ "\$\(cat '[^']*\.orca-fence-owner' 2>\/dev\/null\)" = /u

function stoppedHost(): FakeOrcadHost {
  const stopped = FakeOrcadHost.deployedOld()
  stopped.alive.clear()
  return stopped
}

beforeEach(() => {
  vi.clearAllMocks()
  trail = []
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
    trail.push({ command, fenced: host.fence })
    return host.exec(command)
  })
  vi.mocked(acquireInstallLock).mockImplementation(async (_conn, root, _host, options) => {
    trail.push({ command: 'acquire', fenced: host.fence })
    // mkdir is exclusive: a held fence is busy to every other owner.
    if (host.fence || !host.acquireFence(options)) {
      throw new RemoteInstallLockBusyError(root, 0)
    }
    host.wakeOwner = options?.owner?.token ?? null
  })
})

describe('wakeExpectedOrcadUnderOneFence', () => {
  it('takes one fence, writes nothing before it, and launches only under its guard', async () => {
    host = stoppedHost()
    const record = host.record

    expect(await wakeExpectedOrcadUnderOneFence(slot, OLD)).toMatchObject({ outcome: 'started' })

    expect(trail[0]).toEqual({ command: 'acquire', fenced: false })
    expect(trail.filter((step) => step.command === 'acquire')).toHaveLength(1)
    const held = trail.slice(1)
    // Every decision read and the launch ran under the held fence, behind its owner guard.
    expect(held.every((step) => step.fenced && GUARD.test(step.command))).toBe(true)
    expect(launches()).toHaveLength(1)
    expect(host.record).toBe(record)
    expect(host.fence).toBe(false)
  })

  it('replans without launching when another version became active', async () => {
    host = stoppedHost()
    expect(await wakeExpectedOrcadUnderOneFence(slot, NEW)).toEqual({ outcome: 'replan' })
    expect(launches()).toEqual([])
    expect(host.fence).toBe(false)
  })

  it('leaves a serving slot alone', async () => {
    host = FakeOrcadHost.deployedOld()
    expect(await wakeExpectedOrcadUnderOneFence(slot, OLD)).toEqual({ outcome: 'serving' })
    expect(launches()).toEqual([])
    expect(host.fence).toBe(false)
  })

  it('reports a busy fence without touching it or launching', async () => {
    host = stoppedHost()
    host.fence = true
    host.wakeOwner = 'another-run'
    expect(await wakeExpectedOrcadUnderOneFence(slot, OLD)).toEqual({ outcome: 'fenced' })
    expect(launches()).toEqual([])
    expect(host.fence).toBe(true)
    expect(host.wakeOwner).toBe('another-run')
  })

  it('never launches twice for two connects at once, in one app or two', async () => {
    host = stoppedHost()
    const [first, second] = await Promise.all([
      wakeExpectedOrcadUnderOneFence(slot, OLD),
      wakeExpectedOrcadUnderOneFence(slot, OLD)
    ])
    expect([first.outcome, second.outcome].toSorted()).toEqual(['serving', 'started'])
    expect(launches()).toHaveLength(1)
    // Another app shares no in-process queue; the fence alone keeps it from launching too.
    host = stoppedHost()
    trail = []
    const otherApp = { ...slot, conn: transportFor('wsl:other') }
    const outcomes = await Promise.all([
      wakeExpectedOrcadUnderOneFence(slot, OLD),
      wakeExpectedOrcadUnderOneFence(otherApp, OLD)
    ])
    expect(outcomes.map((wake) => wake.outcome).toSorted()).toEqual(['fenced', 'started'])
    expect(launches()).toHaveLength(1)
    expect(host.fence).toBe(false)
  })

  it('leaves no lock behind when acquisition itself fails', async () => {
    host = stoppedHost()
    vi.mocked(acquireInstallLock).mockRejectedValueOnce(new Error('mkdir: permission denied'))
    await expect(wakeExpectedOrcadUnderOneFence(slot, OLD)).rejects.toThrow('permission denied')
    expect(host.fence).toBe(false)
    expect(launches()).toEqual([])
  })

  it.each([
    ['a full wake', () => wakeStoppedManagedOrcad(slot)],
    ['a one-fence wake', () => wakeExpectedOrcadUnderOneFence(slot, OLD)]
  ])('leaves the fence %s dropped to the full wake that can reclaim it', async (_, dropped) => {
    host = stoppedHost()
    const lost = Object.assign(new Error('connection lost'), { sshChannelCloseConfirmed: false })
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('nohup')) {
        throw lost
      }
      return host.exec(command)
    })
    await expect(dropped()).rejects.toBe(lost)
    const owner = host.wakeOwner
    expect(host.fence).toBe(true)
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))

    // Its token stays the dropped wake's, so the full wake still proves the fence its own.
    expect(await wakeExpectedOrcadUnderOneFence(slot, OLD)).toEqual({ outcome: 'fenced' })
    expect(host.wakeOwner).toBe(owner)
    expect(await wakeStoppedManagedOrcad(slot)).toMatchObject({ outcome: 'started' })
    expect(host.fence).toBe(false)
  })

  it("forgets an interrupted token once a serving wake finds its fence gone or another owner's", async () => {
    const dropOneFenceWake = async () => {
      host = stoppedHost()
      const lost = Object.assign(new Error('connection lost'), { sshChannelCloseConfirmed: false })
      vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
        if (command.includes('nohup')) {
          throw lost
        }
        return host.exec(command)
      })
      await expect(wakeExpectedOrcadUnderOneFence(slot, OLD)).rejects.toBe(lost)
      vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
      // Another client's recovery started the slot meanwhile.
      host.alive.add(OLD)
    }
    for (const [fence, owner] of [
      [false, null],
      [true, 'another-run']
    ] as const) {
      await dropOneFenceWake()
      host.fence = fence
      host.wakeOwner = owner
      expect(await wakeStoppedManagedOrcad(slot)).toEqual({ outcome: 'serving' })
      host.fence = false
      expect(await wakeExpectedOrcadUnderOneFence(slot, OLD)).toEqual({ outcome: 'serving' })
    }
    // Still its own fence, but a journal names work under it: the token and the fence both stay.
    await dropOneFenceWake()
    host.journal = '{}'
    expect(await wakeStoppedManagedOrcad(slot)).toEqual({ outcome: 'serving' })
    expect(host.fence).toBe(true)
    expect(await wakeExpectedOrcadUnderOneFence(slot, OLD)).toEqual({ outcome: 'fenced' })
  })

  it('releases its own journal-free wake fence once the dropped launch is proven serving', async () => {
    host = stoppedHost()
    const lost = Object.assign(new Error('connection lost'), { sshChannelCloseConfirmed: false })
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('nohup')) {
        // The launch reached the host and started the slot; only the reply was lost.
        host.exec(command)
        host.alive.add(OLD)
        throw lost
      }
      return host.exec(command)
    })
    await expect(wakeStoppedManagedOrcad(slot)).rejects.toBe(lost)
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
    expect(host.fence).toBe(true)

    expect(await wakeStoppedManagedOrcad(slot)).toEqual({ outcome: 'serving' })
    // Released through the owner-guarded command, so deploys no longer see a busy fence.
    expect(host.fence).toBe(false)
    expect(host.commands.some((command) => command.includes('echo RELEASED'))).toBe(true)
    expect(await wakeExpectedOrcadUnderOneFence(slot, OLD)).toEqual({ outcome: 'serving' })
  })

  it('never releases a fence another run holds, even with the slot serving', async () => {
    host = stoppedHost()
    const lost = Object.assign(new Error('connection lost'), { sshChannelCloseConfirmed: false })
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('nohup')) {
        throw lost
      }
      return host.exec(command)
    })
    await expect(wakeStoppedManagedOrcad(slot)).rejects.toBe(lost)
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
    host.alive.add(OLD)
    host.wakeOwner = 'another-run'

    expect(await wakeStoppedManagedOrcad(slot)).toEqual({ outcome: 'serving' })
    expect(host.fence).toBe(true)
    expect(host.wakeOwner).toBe('another-run')
  })
})
