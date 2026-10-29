import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emptyOrcadActivationRecord,
  type OrcadActivationRecord
} from '../managed-server/activation/orcad-activation-record'
import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'

type FakeHost = {
  lock: string | null
  alive: Set<number>
  /** Start ticks of each live PID; a restarted distro gives a reused PID other ticks. */
  ticks: Map<number, string>
  guestAnswers: boolean
  pidFiles: Map<string, number>
  record: unknown
  transaction: unknown
  stopTarget: unknown
  readinessBuildHash: string
  slotBuildHash: string
  commands: string[]
  writes: unknown[]
  fenced: boolean
}

const host = vi.hoisted((): FakeHost => ({
  lock: null,
  alive: new Set(),
  ticks: new Map(),
  guestAnswers: true,
  pidFiles: new Map(),
  record: null,
  transaction: null,
  stopTarget: null,
  readinessBuildHash: 'abcdefabcdefabcd',
  slotBuildHash: 'abcdefabcdefabcd',
  commands: [],
  writes: [],
  fenced: false
}))

vi.mock('../managed-server/install/orcad-remote-record-file', () => ({
  readBoundedOrcadRemoteRecord: async () =>
    host.lock === null ? { state: 'absent' } : { state: 'present', raw: host.lock }
}))
const BOOT_ID = '0f6e1d2c-3b4a-4958-8776-655443322110'
const LOCK_TICKS = '4242'
function procStat(pid: number, ticks: string): string {
  return `${pid} (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${ticks} 0`
}
vi.mock('../ssh/remote-exec/remote-exec-command', () => ({
  execCommand: async (_conn: unknown, command: string) => {
    host.commands.push(command)
    if (!host.guestAnswers) {
      throw new Error('wsl.exe did not answer')
    }
    const pid = Number(/cat \/proc\/(\d+)\/stat 2>/.exec(command)?.[1])
    const stat = host.alive.has(pid) ? procStat(pid, host.ticks.get(pid) ?? LOCK_TICKS) : ''
    const section = '--orca-identity--'
    return `${BOOT_ID}\n${section}\n${procStat(1, '1')}\n${section}\n${stat}\n${section}\n`
  }
}))
vi.mock('../managed-server/install/orcad-remote-runtime-control', () => ({
  execOrcadRemote: async (_slot: unknown, command: string) => {
    host.commands.push(command)
    // kill -0 proves only PID presence, never process incarnation.
    const kill = /kill -0 (\d+)/.exec(command)
    if (kill) {
      return host.alive.has(Number(kill[1])) ? 'LIVE\n' : 'DEAD\n'
    }
    const cat = /^cat '([^']+)'/.exec(command)
    if (cat) {
      return `${host.pidFiles.get(cat[1]) ?? ''}\n`
    }
    if (command.startsWith('head -c')) {
      return `${JSON.stringify({
        type: 'orca_server_ready',
        runtimeId: 'r1',
        health: { buildHash: host.readinessBuildHash, buildVersion: '0.1.0' }
      })}\n`
    }
    return ''
  }
}))
vi.mock('../managed-server/lifecycle/orcad-managed-remote-stop', () => ({
  readRemoteOrcadManagedStopTarget: async () => host.stopTarget
}))
vi.mock('../ssh/orcad-recovery-slot', () => ({
  orcadSlotDir: (_slot: unknown, version: string) => `/home/u/.orca-remote/orcad-${version}`,
  resolveOrcadSlotIdentity: async (_slot: unknown, version: string) => ({
    version,
    remoteDir: `/home/u/.orca-remote/orcad-${version}`,
    buildHash: host.slotBuildHash
  })
}))
vi.mock('../managed-server/activation/orcad-activation-gate', () => ({
  evaluateOrcadActivation: (
    readiness: { health?: { buildHash?: string } } | null,
    expected: { buildHash: string }
  ) =>
    readiness?.health?.buildHash === expected.buildHash
      ? { decision: 'accept' }
      : { decision: 'reject', reason: 'its build does not match the installed slot.' }
}))
vi.mock('../managed-server/activation/orcad-activation-record-store', () => ({
  readOrcadActivationRecord: async () => host.record,
  writeOrcadActivationRecord: async (_slot: unknown, record: unknown) => {
    host.writes.push(record)
  }
}))
vi.mock('../managed-server/activation/orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: async () => host.transaction
}))
vi.mock('../managed-server/activation/orcad-activation-lock', () => ({
  withOrcadActivationLock: async (
    _slot: unknown,
    run: () => Promise<unknown>,
    held: () => unknown
  ) => {
    if (host.fenced) {
      return held()
    }
    return run()
  }
}))

import { adoptUnrecordedWslOrcad } from './wsl-orcad-instance-adoption'

const OLD = '0.1.0+aaaaaaaaaaaa'
const NEW = '0.2.0+bbbbbbbbbbbb'
const slot: OrcadSlotOptions = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
  conn: {} as OrcadSlotOptions['conn'],
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/u',
  nodePath: '',
  userDataDir: '/home/u/.orca',
  bindHost: '127.0.0.1',
  port: 6768
}
const NOW = new Date('2026-10-12T01:00:00.000Z')

function lockFor(pid: number, version: string): string {
  return JSON.stringify({
    pid,
    startedAtMs: 1,
    linuxStartTicks: LOCK_TICKS,
    bootId: BOOT_ID,
    identity: '1000',
    version,
    acquiredAt: '2026-10-11T00:00:00.000Z',
    nonce: 'n1',
    role: 'orcad'
  })
}

function stopTargetFor(pid: number, version: string) {
  return {
    state: 'ready',
    context: {
      version,
      runtimeId: 'r1',
      instance: { pid, startedAtMs: 1, nonce: 'n1', lockPath: '/home/u/.orca/orcad.lock' }
    }
  }
}

function record(overrides: Partial<OrcadActivationRecord> = {}): OrcadActivationRecord {
  return { ...emptyOrcadActivationRecord(), ...overrides }
}

function adopt(current: OrcadActivationRecord) {
  host.record = current
  return adoptUnrecordedWslOrcad(slot, current, () => NOW)
}

describe('adopting an orcad the activation record does not name', () => {
  beforeEach(() => {
    host.lock = null
    host.alive.clear()
    host.ticks.clear()
    host.guestAnswers = true
    host.pidFiles.clear()
    host.transaction = null
    host.stopTarget = null
    host.readinessBuildHash = 'abcdefabcdefabcd'
    host.slotBuildHash = 'abcdefabcdefabcd'
    host.commands.length = 0
    host.writes.length = 0
    host.fenced = false
  })

  it('adopts a stale orcad a removed registration left running, never stopping it', async () => {
    host.lock = lockFor(500, OLD)
    host.alive.add(500)
    host.stopTarget = stopTargetFor(500, OLD)
    const result = await adopt(record({ previous: OLD }))
    expect(result).toMatchObject({ outcome: 'adopted', version: OLD, pid: 500 })
    expect(host.writes).toEqual([
      record({ active: OLD, previous: OLD, activatedAt: NOW.toISOString(), snapshot: null })
    ])
    expect(host.commands).toContain(
      `(umask 077 && printf '%s\\n' 500 > '/home/u/.orca-remote/orcad-${OLD}/.orcad-pid')`
    )
    expect(host.commands.some((command) => /\bkill\b/.test(command))).toBe(false)
  })

  it('records an orcad from a different version as active, keeping the recorded one as previous', async () => {
    host.lock = lockFor(600, OLD)
    host.alive.add(600)
    host.stopTarget = stopTargetFor(600, OLD)
    const result = await adopt(
      record({ active: NEW, activeAppVersion: '1.5.0', activatedAt: '2026-10-10T00:00:00.000Z' })
    )
    expect(result).toMatchObject({ outcome: 'adopted', version: OLD, pid: 600 })
    expect(host.writes).toEqual([
      record({
        active: OLD,
        previous: NEW,
        previousAppVersion: '1.5.0',
        activatedAt: NOW.toISOString(),
        snapshot: null
      })
    ])
  })

  it('repoints only the pid file when the recorded slot is serving under another pid', async () => {
    host.lock = lockFor(700, OLD)
    host.alive.add(700)
    host.pidFiles.set(`/home/u/.orca-remote/orcad-${OLD}/.orcad-pid`, 699)
    host.stopTarget = stopTargetFor(700, OLD)
    const current = record({ active: OLD })
    await expect(adopt(current)).resolves.toMatchObject({ outcome: 'adopted', record: current })
    expect(host.writes).toEqual([])
    expect(host.commands.some((command) => command.includes("printf '%s\\n' 700"))).toBe(true)
  })

  it('leaves the recorded instance, a dead lock holder and a desktop lock alone', async () => {
    host.lock = lockFor(800, OLD)
    host.alive.add(800)
    host.pidFiles.set(`/home/u/.orca-remote/orcad-${OLD}/.orcad-pid`, 800)
    await expect(adopt(record({ active: OLD }))).resolves.toEqual({ outcome: 'none' })
    host.alive.clear()
    await expect(adopt(record())).resolves.toEqual({ outcome: 'none' })
    host.lock = JSON.stringify({ ...JSON.parse(lockFor(800, OLD)), role: 'desktop' })
    host.alive.add(800)
    await expect(adopt(record())).resolves.toEqual({ outcome: 'none' })
    expect(host.writes).toEqual([])
  })

  it('matches a lock that recorded its boot id in upper case', async () => {
    host.lock = JSON.stringify({ ...JSON.parse(lockFor(530, OLD)), bootId: BOOT_ID.toUpperCase() })
    host.alive.add(530)
    host.stopTarget = stopTargetFor(530, OLD)
    await expect(adopt(record())).resolves.toMatchObject({ outcome: 'adopted', pid: 530 })
  })

  it('does not adopt a lock whose PID a distro restart gave to another process', async () => {
    // Stale lock/readiness reuse PID 500; only incarnation evidence distinguishes it.
    host.lock = lockFor(500, OLD)
    host.alive.add(500)
    host.ticks.set(500, '977')
    host.stopTarget = stopTargetFor(500, OLD)
    await expect(adopt(record({ active: NEW }))).resolves.toEqual({ outcome: 'none' })
    expect(host.writes).toEqual([])
  })

  it('never reads an unanswered guest or an unprovable lock as a live holder', async () => {
    host.lock = lockFor(510, OLD)
    host.alive.add(510)
    host.stopTarget = stopTargetFor(510, OLD)
    host.guestAnswers = false
    await expect(adopt(record({ active: NEW }))).resolves.toEqual({ outcome: 'none' })
    host.guestAnswers = true
    // Legacy writers lack kernel incarnation and provide only drifting wall-clock start time.
    const { linuxStartTicks: _ticks, bootId: _boot, ...legacy } = JSON.parse(lockFor(510, OLD))
    host.lock = JSON.stringify(legacy)
    await expect(adopt(record({ active: NEW }))).resolves.toEqual({ outcome: 'none' })
    expect(host.writes).toEqual([])
  })

  it('refuses to adopt when the holder cannot be re-proven under the fence', async () => {
    host.lock = lockFor(520, OLD)
    host.alive.add(520)
    host.stopTarget = stopTargetFor(520, OLD)
    const reads = { count: 0 }
    host.record = record()
    const answers = vi.spyOn(host.alive, 'has').mockImplementation(() => reads.count++ === 0)
    await expect(adoptUnrecordedWslOrcad(slot, record(), () => NOW)).rejects.toThrow(
      /changed while it was being adopted/
    )
    answers.mockRestore()
    expect(host.writes).toEqual([])
  })

  it('refuses, writing nothing, when the running orcad cannot be proven to be its slot', async () => {
    host.lock = lockFor(900, OLD)
    host.alive.add(900)
    host.stopTarget = {
      state: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_managed_stop_instance_unverifiable',
      reason: 'The instance lock does not name the orcad that published readiness.'
    }
    await expect(adopt(record())).rejects.toMatchObject({
      name: 'WslOrcadUnrecordedInstanceError',
      message: expect.stringContaining('cannot be identified')
    })
    host.stopTarget = stopTargetFor(900, OLD)
    host.readinessBuildHash = '0000000000000000'
    await expect(adopt(record())).rejects.toThrow(/does not match the installed slot/)
    expect(host.writes).toEqual([])
  })

  it('refuses under a busy fence, a pending journal or a record that changed', async () => {
    host.lock = lockFor(910, OLD)
    host.alive.add(910)
    host.stopTarget = stopTargetFor(910, OLD)
    host.fenced = true
    await expect(adopt(record())).rejects.toThrow(/Another Orca is changing/)
    host.fenced = false
    host.transaction = { transactionId: 't1' }
    await expect(adopt(record())).rejects.toThrow(/interrupted activation is pending/)
    host.transaction = null
    host.record = record({ active: NEW })
    await expect(adoptUnrecordedWslOrcad(slot, record(), () => NOW)).rejects.toThrow(
      /record changed/
    )
    expect(host.writes).toEqual([])
  })
})
