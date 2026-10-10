import type * as FsModule from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDaemonPidPath, getDaemonSocketPath } from './daemon-spawner'
import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'

const {
  probeSocketMock,
  adapterConstructions,
  adapterInstances,
  listSessionsImpls,
  hasChildProcessesImpls,
  pidFileContents
} = vi.hoisted(() => ({
  probeSocketMock: vi.fn(async (_socketPath: string) => false),
  adapterConstructions: [] as { options: Record<string, unknown> }[],
  adapterInstances: [] as {
    protocolVersion: number
    listSessions: ReturnType<typeof vi.fn>
    hasChildProcesses: ReturnType<typeof vi.fn>
  }[],
  listSessionsImpls: new Map<number, () => Promise<{ sessionId: string }[]>>(),
  hasChildProcessesImpls: new Map<string, () => Promise<boolean>>(),
  pidFileContents: new Map<string, string>()
}))

vi.mock('./daemon-launch-paths', () => ({
  getDaemonHistoryDir: () => '/fake/history',
  probeDaemonSocket: (socketPath: string) => probeSocketMock(socketPath)
}))

vi.mock('./daemon-pty-adapter', () => ({
  DaemonPtyAdapter: class {
    protocolVersion: number
    listSessions: ReturnType<typeof vi.fn>
    hasChildProcesses: ReturnType<typeof vi.fn>
    constructor(options: Record<string, unknown>) {
      this.protocolVersion = options.protocolVersion as number
      adapterConstructions.push({ options })
      this.listSessions = vi.fn(async (_opts?: { deadlineMs?: number }) => {
        const impl = listSessionsImpls.get(this.protocolVersion)
        return impl ? impl() : []
      })
      this.hasChildProcesses = vi.fn(
        async (sessionId: string, _opts?: { deadlineMs?: number }) => {
          const impl = hasChildProcessesImpls.get(sessionId)
          return impl ? impl() : false
        }
      )
      adapterInstances.push({
        protocolVersion: this.protocolVersion,
        listSessions: this.listSessions,
        hasChildProcesses: this.hasChildProcesses
      })
    }
  }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  return {
    ...actual,
    readFileSync: ((path: unknown, _options?: unknown) => {
      const contents = pidFileContents.get(String(path))
      if (contents === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return contents
    }) as typeof actual.readFileSync,
    unlinkSync: vi.fn()
  }
})

const RUNTIME_DIR = '/fake/runtime'

function validPidRecord(pid: number): string {
  return JSON.stringify({
    pid,
    startedAtMs: 1_000,
    entryPath: null,
    appVersion: null,
    launchNonce: null,
    linuxStartTicks: null,
    bootId: null,
    spawnerExecPath: null
  })
}

describe('createLegacyDaemonAdapters registry', () => {
  beforeEach(() => {
    probeSocketMock.mockReset().mockResolvedValue(false)
    adapterConstructions.length = 0
    adapterInstances.length = 0
    listSessionsImpls.clear()
    hasChildProcessesImpls.clear()
    pidFileContents.clear()
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds a registry entry with protocol version, pid, socket path, and per-session busy/idle state', async () => {
    const protocolVersion = 9
    const socketPath = getDaemonSocketPath(RUNTIME_DIR, protocolVersion)
    probeSocketMock.mockImplementation(async (path: string) => path === socketPath)
    pidFileContents.set(getDaemonPidPath(RUNTIME_DIR, protocolVersion), validPidRecord(4242))
    listSessionsImpls.set(protocolVersion, async () => [
      { sessionId: 'legacy-idle' },
      { sessionId: 'legacy-busy' }
    ])
    hasChildProcessesImpls.set('legacy-idle', async () => false)
    hasChildProcessesImpls.set('legacy-busy', async () => true)

    const { adapters, registry } = await createLegacyDaemonAdapters(RUNTIME_DIR)

    expect(adapters).toHaveLength(1)
    expect(adapters[0].protocolVersion).toBe(protocolVersion)
    expect(registry).toEqual([
      {
        protocolVersion,
        pid: 4242,
        socketPath,
        sessions: [
          { sessionId: 'legacy-idle', busy: false },
          { sessionId: 'legacy-busy', busy: true }
        ]
      }
    ])
  })

  it('omits both the adapter and the registry entry for a protocol version whose socket is unreachable and whose pid is confirmed dead', async () => {
    const protocolVersion = 9
    pidFileContents.set(getDaemonPidPath(RUNTIME_DIR, protocolVersion), validPidRecord(99_999))

    const { adapters, registry } = await createLegacyDaemonAdapters(RUNTIME_DIR)

    expect(adapters).toEqual([])
    expect(registry).toEqual([])
  })

  it('still returns an adapter and a registry entry with an empty session list when the session inventory RPC fails', async () => {
    const protocolVersion = 9
    const socketPath = getDaemonSocketPath(RUNTIME_DIR, protocolVersion)
    probeSocketMock.mockImplementation(async (path: string) => path === socketPath)
    pidFileContents.set(getDaemonPidPath(RUNTIME_DIR, protocolVersion), validPidRecord(4242))
    listSessionsImpls.set(protocolVersion, async () => {
      throw new Error('legacy daemon unreachable mid-inventory')
    })

    const { adapters, registry } = await createLegacyDaemonAdapters(RUNTIME_DIR)

    expect(adapters).toHaveLength(1)
    expect(registry).toEqual([{ protocolVersion, pid: 4242, socketPath, sessions: [] }])
  })

  it('leaves pid null in the registry entry when the pid record cannot be read for a live generation', async () => {
    const protocolVersion = 9
    const socketPath = getDaemonSocketPath(RUNTIME_DIR, protocolVersion)
    probeSocketMock.mockImplementation(async (path: string) => path === socketPath)
    listSessionsImpls.set(protocolVersion, async () => [])

    const { adapters, registry } = await createLegacyDaemonAdapters(RUNTIME_DIR)

    expect(adapters).toHaveLength(1)
    expect(registry).toEqual([{ protocolVersion, pid: null, socketPath, sessions: [] }])
  })
})

describe('createLegacyDaemonAdapters registry construction deadline', () => {
  beforeEach(() => {
    probeSocketMock.mockReset()
    adapterConstructions.length = 0
    adapterInstances.length = 0
    listSessionsImpls.clear()
    hasChildProcessesImpls.clear()
    pidFileContents.clear()
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('threads one shared absolute deadline into every live generation instead of an unbounded per-generation call', async () => {
    const protocolVersionA = 8
    const protocolVersionB = 9
    const socketPathA = getDaemonSocketPath(RUNTIME_DIR, protocolVersionA)
    const socketPathB = getDaemonSocketPath(RUNTIME_DIR, protocolVersionB)
    probeSocketMock.mockImplementation(
      async (path: string) => path === socketPathA || path === socketPathB
    )
    listSessionsImpls.set(protocolVersionA, async () => [{ sessionId: 'a-session' }])
    listSessionsImpls.set(protocolVersionB, async () => [{ sessionId: 'b-session' }])
    hasChildProcessesImpls.set('a-session', async () => false)
    hasChildProcessesImpls.set('b-session', async () => false)

    const before = Date.now()
    await createLegacyDaemonAdapters(RUNTIME_DIR)
    const after = Date.now()

    expect(adapterInstances).toHaveLength(2)
    const [instanceA, instanceB] = adapterInstances

    const listSessionsDeadlineA = instanceA.listSessions.mock.calls[0]?.[0]?.deadlineMs
    const listSessionsDeadlineB = instanceB.listSessions.mock.calls[0]?.[0]?.deadlineMs
    const hasChildDeadlineA = instanceA.hasChildProcesses.mock.calls[0]?.[1]?.deadlineMs
    const hasChildDeadlineB = instanceB.hasChildProcesses.mock.calls[0]?.[1]?.deadlineMs

    // Why: a bare undefined deadline would fall back to the client's unbounded
    // per-call REQUEST_TIMEOUT_MS default -- exactly the finding this proves fixed.
    expect(typeof listSessionsDeadlineA).toBe('number')
    expect(typeof hasChildDeadlineA).toBe('number')

    // Why: one shared absolute deadline across every generation, not a fresh
    // per-generation budget, so 35 live generations cannot each burn 30s in series.
    expect(listSessionsDeadlineA).toBe(listSessionsDeadlineB)
    expect(hasChildDeadlineA).toBe(hasChildDeadlineB)
    expect(listSessionsDeadlineA).toBe(hasChildDeadlineA)

    // Why: the deadline is an absolute point in time bounded by this call's own
    // window, not an arbitrary constant unrelated to when construction started.
    expect(listSessionsDeadlineA).toBeGreaterThanOrEqual(before)
    expect(listSessionsDeadlineA).toBeGreaterThan(after)
  })

  it('honors a caller-supplied deadline instead of minting its own', async () => {
    const protocolVersion = 9
    const socketPath = getDaemonSocketPath(RUNTIME_DIR, protocolVersion)
    probeSocketMock.mockImplementation(async (path: string) => path === socketPath)
    listSessionsImpls.set(protocolVersion, async () => [{ sessionId: 'callable-session' }])
    hasChildProcessesImpls.set('callable-session', async () => false)
    const callerDeadlineMs = Date.now() + 12_345

    await createLegacyDaemonAdapters(RUNTIME_DIR, undefined, callerDeadlineMs)

    expect(adapterInstances).toHaveLength(1)
    const [instance] = adapterInstances
    expect(instance.listSessions.mock.calls[0]?.[0]?.deadlineMs).toBe(callerDeadlineMs)
    expect(instance.hasChildProcesses.mock.calls[0]?.[1]?.deadlineMs).toBe(callerDeadlineMs)
  })
})
