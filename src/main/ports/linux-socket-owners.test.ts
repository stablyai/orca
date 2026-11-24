import { describe, expect, it } from 'vitest'
import { createLinuxSocketOwnerResolver, type ProcReader } from './linux-socket-owners'

type FakeProc = { start: string; sockets: number[]; otherFds: number }

function fakeProc(processes: Map<number, FakeProc>): ProcReader & { linkReads: number } {
  const reader = {
    linkReads: 0,
    listPids: async () => [...processes.keys()].map(String),
    listFds: async (pid: string) => {
      const p = processes.get(Number(pid))
      if (!p) {
        throw new Error('ENOENT')
      }
      return Array.from({ length: p.sockets.length + p.otherFds }, (_, i) => String(i))
    },
    readFdLink: async (pid: string, fd: string) => {
      reader.linkReads += 1
      const p = processes.get(Number(pid))
      if (!p) {
        throw new Error('ENOENT')
      }
      const i = Number(fd)
      return i < p.sockets.length ? `socket:[${p.sockets[i]}]` : `/dev/null`
    },
    readStat: async (pid: string) => {
      const p = processes.get(Number(pid))
      if (!p) {
        throw new Error('ENOENT')
      }
      return `${pid} (node worker) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${p.start} 0`
    }
  }
  return reader
}

const LISTENER = 4242
const inodes = new Set([LISTENER])

function machine(): Map<number, FakeProc> {
  const processes = new Map<number, FakeProc>()
  for (let pid = 1; pid <= 500; pid++) {
    processes.set(pid, { start: String(pid), sockets: [], otherFds: 20 })
  }
  processes.set(100, { start: 'supervisor', sockets: [LISTENER], otherFds: 20 })
  return processes
}

describe('Linux socket owner resolver', () => {
  it('answers like a full walk on every scan while reading far fewer fd links', async () => {
    const processes = machine()
    const proc = fakeProc(processes)
    const resolve = createLinuxSocketOwnerResolver(proc, () => 0)
    const fullWalk = async (): Promise<number | undefined> =>
      (await createLinuxSocketOwnerResolver(fakeProc(processes))(inodes, inodes)).get(LISTENER)

    expect((await resolve(inodes, inodes)).get(LISTENER)).toBe(100)
    const afterFirstWalk = proc.linkReads
    expect((await resolve(inodes, inodes)).get(LISTENER)).toBe(100)
    expect(proc.linkReads - afterFirstWalk).toBeLessThan(afterFirstWalk / 50)

    // Fork handoff: a new child takes the socket and the supervisor closes its copy but keeps running.
    processes.set(900, { start: 'child', sockets: [LISTENER], otherFds: 5 })
    processes.set(100, { start: 'supervisor', sockets: [], otherFds: 20 })
    expect((await resolve(inodes, inodes)).get(LISTENER)).toBe(await fullWalk())
    expect((await resolve(inodes, inodes)).get(LISTENER)).toBe(900)

    // Shared listener: a new worker also holds it while the current owner keeps its copy.
    processes.set(950, { start: 'worker', sockets: [LISTENER], otherFds: 5 })
    expect((await resolve(inodes, inodes)).get(LISTENER)).toBe(await fullWalk())

    // Owner exits and leaves the socket with an older holder.
    processes.set(300, { start: '300', sockets: [LISTENER], otherFds: 20 })
    processes.delete(950)
    processes.delete(900)
    expect((await resolve(inodes, inodes)).get(LISTENER)).toBe(await fullWalk())
  })

  it('walks everything again once the reused map is 10 scans or 5 minutes old', async () => {
    const processes = machine()
    let clock = 0
    const proc = fakeProc(processes)
    const resolve = createLinuxSocketOwnerResolver(proc, () => clock)
    await resolve(inodes, inodes)
    const walk = proc.linkReads
    for (let scan = 1; scan < 10; scan++) {
      await resolve(inodes, inodes)
    }
    expect(proc.linkReads).toBeLessThan(walk * 2)
    await resolve(inodes, inodes)
    expect(proc.linkReads).toBeGreaterThanOrEqual(walk * 2)

    const beforeAged = proc.linkReads
    clock += 5 * 60_000
    await resolve(inodes, inodes)
    expect(proc.linkReads - beforeAged).toBeGreaterThanOrEqual(walk)

    const beforeFresh = proc.linkReads
    await resolve(inodes, inodes, { requireFresh: true })
    expect(proc.linkReads - beforeFresh).toBeGreaterThanOrEqual(walk)
  })
})
