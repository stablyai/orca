import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WindowsProcessEvidence } from '../../daemon/endpoint/identity/daemon-incarnation-evidence-types'
import { WSL_DISTRO_HOLDER_MARKER } from './wsl-distro-holder-command'
import {
  WSL_HOLDER_UNVERIFIABLE_REPLACE_AFTER_MS,
  createWslDistroHolder
} from './wsl-distro-holder'
import type { WslDistroHolderChild, WslDistroHolderDependencies } from './wsl-distro-holder-types'
import { wslDistroHolderDirectory, type WslDistroHolderRecord } from './wsl-distro-holder-record'

const HOLDER_COMMAND = (distro: string): string =>
  `C:\\Windows\\System32\\wsl.exe -d ${distro} --exec /bin/sh -c "while :; do sleep 3600; done" ${WSL_DISTRO_HOLDER_MARKER}`

type FakeProcess = { commandLine: string | null; startedAtMs: number | null }

class FakeHost {
  processes = new Map<number, FakeProcess>()
  running = new Set<string>()
  tableFails = false
  nextPid = 4000
  spawned: string[] = []
  killed: number[] = []
  children: (EventEmitter & { pid?: number; unref: () => void })[] = []

  query = async (pid: number): Promise<WindowsProcessEvidence> => {
    if (this.tableFails) {
      return { status: 'unavailable' }
    }
    const row = this.processes.get(pid)
    return row ? { status: 'present', ...row } : { status: 'missing' }
  }

  spawn = (distro: string): WslDistroHolderChild => {
    const pid = this.nextPid++
    this.spawned.push(distro)
    const child = Object.assign(new EventEmitter(), { pid, unref: vi.fn() })
    this.children.push(child)
    this.processes.set(pid, { commandLine: HOLDER_COMMAND(distro), startedAtMs: 1_000 + pid })
    this.running.add(distro.toLowerCase())
    queueMicrotask(() => child.emit('spawn'))
    return child
  }

  kill = (pid: number): void => {
    this.killed.push(pid)
    this.processes.delete(pid)
  }
}

let userDataPath: string
let host: FakeHost

function makeHolder(overrides: Partial<WslDistroHolderDependencies> = {}) {
  return createWslDistroHolder({
    userDataPath,
    spawnHolder: host.spawn,
    queryProcess: host.query,
    killProcess: host.kill,
    listRunningDistros: async () => [...host.running],
    sleep: async () => {},
    ...overrides
  })
}

async function writeRecord(record: WslDistroHolderRecord): Promise<void> {
  const directory = wslDistroHolderDirectory(userDataPath)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, `${encodeURIComponent(record.distro.toLowerCase())}.json`),
    JSON.stringify(record)
  )
}

async function recordFiles(): Promise<string[]> {
  return readdir(wslDistroHolderDirectory(userDataPath)).catch(() => [])
}

function record(overrides: Partial<WslDistroHolderRecord> = {}): WslDistroHolderRecord {
  return {
    version: 1,
    distro: 'Alpine',
    pid: 77,
    creationTimeMs: 5_000,
    startedAtMs: 5_001,
    ...overrides
  }
}

beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), 'wsl-distro-holder-'))
  host = new FakeHost()
})

afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true })
})

describe('createWslDistroHolder', () => {
  it('a background ensure re-reads the running list right before spawning, and never boots (E9)', async () => {
    const holder = makeHolder()
    const requireRunning = vi.fn(async () => false)
    await expect(holder.ensureHeld('Alpine', { requireRunning })).rejects.toThrow('isn’t running')
    expect(host.spawned).toEqual([])

    requireRunning.mockResolvedValue(true)
    expect((await holder.ensureHeld('Alpine', { requireRunning })).outcome).toBe('spawned')
    expect(host.spawned).toEqual(['Alpine'])
  })

  it('a user ensure is not refused by a background one in flight for a stopped distro', async () => {
    const holder = makeHolder()
    const asked = vi.fn(async () => false)
    const background = holder.ensureHeld('Alpine', { requireRunning: asked })
    const user = holder.ensureHeld('Alpine')
    await expect(background).rejects.toThrow('isn’t running')
    // The user's own act may start the distro.
    expect((await user).outcome).toBe('spawned')
    expect(host.spawned).toEqual(['Alpine'])
  })

  it('single-flights concurrent ensures for one distro', async () => {
    const holder = makeHolder()
    const [a, b] = await Promise.all([holder.ensureHeld('Alpine'), holder.ensureHeld('alpine')])
    expect(a).toBe(b)
    expect(host.spawned).toEqual(['Alpine'])
    expect((await holder.ensureHeld('Alpine')).outcome).toBe('adopted')
    expect(host.spawned).toHaveLength(1)
  })

  it('releases every verified holder it recorded and nothing it cannot verify', async () => {
    host.processes.set(77, { commandLine: HOLDER_COMMAND('Alpine'), startedAtMs: 5_000 })
    await writeRecord(record())
    // A reused pid now running something else must never be killed.
    host.processes.set(88, { commandLine: 'C:\\Windows\\notepad.exe', startedAtMs: 6_000 })
    await writeRecord(record({ distro: 'Debian', pid: 88, creationTimeMs: 6_000 }))
    const released = await makeHolder().releaseAll()
    expect(released.sort((a, b) => a.distro.localeCompare(b.distro))).toEqual([
      { distro: 'alpine', state: 'exited' },
      { distro: 'debian', state: 'exited' }
    ])
    expect(host.killed).toEqual([77])
    expect(await recordFiles()).toEqual([])
  })

  it('never kills a holder whose record has no start time to rule out pid reuse', async () => {
    host.processes.set(77, { commandLine: HOLDER_COMMAND('Alpine'), startedAtMs: 5_000 })
    await writeRecord(record({ creationTimeMs: null }))
    expect(await makeHolder().releaseAll()).toEqual([{ distro: 'alpine', state: 'unverifiable' }])
    expect(host.killed).toEqual([])
    expect(await recordFiles()).toHaveLength(1)
  })

  it('keeps the record and reports unverifiable when the process table fails', async () => {
    host.processes.set(77, { commandLine: HOLDER_COMMAND('Alpine'), startedAtMs: 5_000 })
    await writeRecord(record())
    host.tableFails = true
    const holder = makeHolder()
    expect(await holder.adoptHolders()).toEqual([{ distro: 'Alpine', state: 'unverifiable' }])
    expect(await holder.holderState('Alpine')).toBe('unverifiable')
    expect((await holder.ensureHeld('Alpine')).outcome).toBe('unverifiable')
    expect(await holder.release('Alpine')).toBe('unverifiable')
    expect(host.spawned).toEqual([])
    expect(host.killed).toEqual([])
    expect(await recordFiles()).toEqual(['alpine.json'])
  })

  it('fails and cleans up when the holder exits before its record is written', async () => {
    const holder = makeHolder({
      listRunningDistros: async () => [],
      spawnHolder: (distro) => {
        const child = host.spawn(distro)
        // Right after 'spawn', before the process-table lookup resolves (a bad distro name).
        queueMicrotask(() => {
          host.processes.delete(child.pid ?? 0)
          child.emit('exit', 1, null)
        })
        return child
      },
      bootTimeoutMs: 1_000_000
    })
    await expect(holder.ensureHeld('Missing')).rejects.toThrow(/exited before the distro started/)
    expect(await recordFiles()).toEqual([])
  })

  it('stops the holder when the distro never starts', async () => {
    let clock = 0
    const holder = makeHolder({
      listRunningDistros: async () => [],
      monotonicNow: () => (clock += 1_000),
      // A wall clock stuck in the past must not stretch the deadline.
      now: () => 0,
      bootTimeoutMs: 3_000
    })
    await expect(holder.ensureHeld('Alpine')).rejects.toThrow(/did not start/)
    expect(host.killed).toEqual([4000])
    expect(await recordFiles()).toEqual([])
  })

  it('release keeps polling through an unverifiable window until the exit is proven', async () => {
    const holder = makeHolder()
    await holder.ensureHeld('Alpine')
    // Mid-exit: the pid is still listed but its command line is already unreadable.
    let midExitReads = 2
    host.kill = (pid) => {
      host.killed.push(pid)
      host.processes.set(pid, { commandLine: null, startedAtMs: 5_000 })
    }
    const query = host.query
    host.query = async (pid) => {
      if (host.killed.includes(pid) && midExitReads-- <= 0) {
        host.processes.delete(pid)
      }
      return query(pid)
    }
    const released = createWslDistroHolder({
      userDataPath,
      queryProcess: (pid) => host.query(pid),
      killProcess: (pid) => host.kill(pid),
      sleep: async () => {}
    })
    expect(await released.release('Alpine')).toBe('exited')
    expect(await recordFiles()).toEqual([])
    expect(await holder.holderState('Alpine')).toBe('exited')
  })

  it('release reports unverifiable and keeps the record when the exit is never proven', async () => {
    const holder = makeHolder()
    await holder.ensureHeld('Alpine')
    let clock = 0
    let notifySleep = () => {}
    let resumeSleep: (nextClock: number) => void = () => {}
    const firstSleep = new Promise<void>((resolve) => {
      notifySleep = resolve
    })
    const released = makeHolder({
      killProcess: (pid) => {
        host.killed.push(pid)
        host.processes.set(pid, { commandLine: null, startedAtMs: 5_000 })
      },
      now: () => 0,
      monotonicNow: () => clock,
      sleep: () =>
        new Promise<void>((resolve) => {
          resumeSleep = (nextClock) => {
            clock = nextClock
            resolve()
          }
          notifySleep()
        })
    })
    let settled = false
    const release = released.release('Alpine').then((state) => {
      settled = true
      return state
    })
    await firstSleep
    expect(settled).toBe(false)
    const finalSleep = new Promise<void>((resolve) => {
      notifySleep = resolve
    })
    resumeSleep(4_999)
    await finalSleep
    expect(settled).toBe(false)
    expect(await recordFiles()).toEqual(['alpine.json'])
    resumeSleep(5_000)
    expect(await release).toBe('unverifiable')
    expect(host.killed).toEqual([4000])
    expect(await recordFiles()).toEqual(['alpine.json'])
  })

  it('serializes release behind an in-flight ensure', async () => {
    const holder = makeHolder()
    const ensure = holder.ensureHeld('Alpine')
    const release = holder.release('Alpine')
    await ensure
    expect(await release).toBe('exited')
    expect(host.killed).toEqual([4000])
  })

  it('spawns another holder only after staying unverifiable past the bound while running', async () => {
    await writeRecord(record())
    host.running.add('alpine')
    let clock = 0
    const query = host.query
    const holder = makeHolder({
      monotonicNow: () => clock,
      // The recorded holder's row stays unreadable; a new holder's own lookup works.
      queryProcess: async (pid) => (pid === 77 ? { status: 'unavailable' } : query(pid))
    })
    expect((await holder.ensureHeld('Alpine')).outcome).toBe('unverifiable')
    clock = WSL_HOLDER_UNVERIFIABLE_REPLACE_AFTER_MS - 1
    expect((await holder.ensureHeld('Alpine')).outcome).toBe('unverifiable')
    expect(host.spawned).toEqual([])
    clock = WSL_HOLDER_UNVERIFIABLE_REPLACE_AFTER_MS
    const result = await holder.ensureHeld('Alpine')
    expect(result).toMatchObject({ outcome: 'spawned', record: { pid: 4000 } })
    expect(host.spawned).toEqual(['Alpine'])
    expect(host.killed).toEqual([])
  })

  it('never doubles an unverifiable holder while the distro is not confirmed running', async () => {
    await writeRecord(record())
    let clock = 0
    const holder = makeHolder({
      monotonicNow: () => clock,
      queryProcess: async () => ({ status: 'unavailable' }),
      listRunningDistros: async () => []
    })
    expect((await holder.ensureHeld('Alpine')).outcome).toBe('unverifiable')
    clock = WSL_HOLDER_UNVERIFIABLE_REPLACE_AFTER_MS * 10
    expect((await holder.ensureHeld('Alpine')).outcome).toBe('unverifiable')
    expect(host.spawned).toEqual([])
  })
})

describe('releaseAll for uninstall', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('kills a matching holder with no start time on either side, and logs its pid', async () => {
    host.processes.set(77, { commandLine: HOLDER_COMMAND('Alpine'), startedAtMs: 5_000 })
    await writeRecord(record({ creationTimeMs: null }))
    host.processes.set(88, { commandLine: HOLDER_COMMAND('Debian'), startedAtMs: null })
    await writeRecord(record({ distro: 'Debian', pid: 88, creationTimeMs: 6_000 }))
    const released = await makeHolder().releaseAll({ forUninstall: true })
    expect(released.sort((a, b) => a.distro.localeCompare(b.distro))).toEqual([
      { distro: 'alpine', state: 'exited' },
      { distro: 'debian', state: 'exited' }
    ])
    expect(host.killed.sort()).toEqual([77, 88])
    expect(await recordFiles()).toEqual([])
  })

  it('never kills a pid whose command line is not the holder for the recorded distro', async () => {
    host.processes.set(77, { commandLine: 'C:\\Windows\\notepad.exe', startedAtMs: 5_000 })
    await writeRecord(record({ creationTimeMs: null }))
    host.processes.set(88, { commandLine: HOLDER_COMMAND('Ubuntu'), startedAtMs: null })
    await writeRecord(record({ distro: 'Debian', pid: 88, creationTimeMs: null }))
    const released = await makeHolder().releaseAll({ forUninstall: true })
    expect(released.sort((a, b) => a.distro.localeCompare(b.distro))).toEqual([
      { distro: 'alpine', state: 'exited' },
      { distro: 'debian', state: 'exited' }
    ])
    expect(host.killed).toEqual([])
  })

  it('still trusts a known start time that contradicts the record', async () => {
    host.processes.set(77, { commandLine: HOLDER_COMMAND('Alpine'), startedAtMs: 9_999 })
    await writeRecord(record())
    expect(await makeHolder().releaseAll({ forUninstall: true })).toEqual([
      { distro: 'alpine', state: 'exited' }
    ])
    expect(host.killed).toEqual([])
  })

  it('reads an unavailable process table once more before giving up', async () => {
    host.processes.set(77, { commandLine: HOLDER_COMMAND('Alpine'), startedAtMs: 5_000 })
    await writeRecord(record())
    host.tableFails = true
    const sleep = vi.fn(async () => {
      host.tableFails = false
    })
    expect(await makeHolder({ sleep }).releaseAll({ forUninstall: true })).toEqual([
      { distro: 'alpine', state: 'exited' }
    ])
    expect(host.killed).toEqual([77])

    host.processes.set(78, { commandLine: HOLDER_COMMAND('Alpine'), startedAtMs: 5_000 })
    await writeRecord(record({ pid: 78 }))
    host.tableFails = true
    expect(await makeHolder().releaseAll({ forUninstall: true })).toEqual([
      { distro: 'alpine', state: 'unverifiable' }
    ])
    expect(host.killed).toEqual([77])
    expect(await recordFiles()).toEqual(['alpine.json'])
  })
})
