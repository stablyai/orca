import type { Socket } from 'node:net'
import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { connectDaemonSocket } from './daemon-client-socket-connect'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import { WslDaemonPtyProvider } from '../wsl/wsl-daemon-pty-provider'
import { toAppWslPtyId, toRelayWslPtyId } from '../../shared/wsl-pty-id'
import { HistoryReader } from './history-reader'
import type { DaemonPtyRouterDataEvent } from './daemon-pty-router-events'

const { reportCwd } = vi.hoisted(() => ({ reportCwd: vi.fn() }))
vi.mock('./daemon-adoption-telemetry-event', () => ({ reportDaemonPtyCwdVerdict: reportCwd }))

const owner = { distro: 'Ubuntu', relayBuildId: 'profile-user-endpoint' }

describe('guest daemon execution boundary', () => {
  let harness: DaemonAdapterHarness
  let subprocess: ReturnType<typeof createMockSubprocess>
  let adapters: DaemonPtyAdapter[]
  const spawn = vi.fn()
  const connectRoles: string[] = []
  const connections: Socket[] = []
  const guest = () => ({
    distro: owner.distro,
    defaultShell: '/guest-only/bin/bash',
    defaultCwd: '/home/guest',
    profiles: [{ name: 'Guest bash', path: '/guest-only/bin/bash' }],
    transport: {
      readToken: () => readFileSync(harness.tokenPath, 'utf8').trim(),
      connect: async (role: 'control' | 'stream', operation: { timeoutMs: number }) => {
        connectRoles.push(role)
        const socket = await connectDaemonSocket(harness.socketPath, operation.timeoutMs)
        connections.push(socket)
        return socket
      }
    }
  })
  function provider(historyPath?: string) {
    const adapter = new DaemonPtyAdapter({ guest: guest(), historyPath })
    adapters.push(adapter)
    return { adapter, provider: new WslDaemonPtyProvider(owner, adapter) }
  }
  beforeEach(async () => {
    adapters = []
    connectRoles.length = 0
    connections.length = 0
    spawn.mockReset()
    reportCwd.mockReset()
    subprocess = createMockSubprocess()
    harness = await startDaemonAdapterHarness((options) => {
      spawn(options)
      return subprocess
    })
  })
  afterEach(async () => {
    adapters.forEach((adapter) => adapter.dispose())
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  })

  it('uses guest defaults and both authenticated channels without desktop paths', async () => {
    const { provider: p, adapter } = provider()
    const result = await p.spawn({ cols: 80, rows: 24, isNewSession: true })
    expect(result.id).toMatch(/^wsl:/)
    expect(result.wslDistro).toBe('Ubuntu')
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/home/guest',
        shellOverride: '/guest-only/bin/bash'
      })
    )
    expect(connectRoles).toEqual(['control', 'stream'])
    expect(await p.getDefaultShell()).toBe('/guest-only/bin/bash')
    expect(await p.getProfiles()).toEqual(guest().profiles)
    expect(adapter.getLastAuthenticatedDaemonIdentity()).not.toBeNull()
    await p.listProcesses()
    expect(adapter.getLastAuditObservation()).toBeNull()
    expect(reportCwd).not.toHaveBeenCalled()
  })

  it('delivers plain guest shell input without waiting for an unrequested startup marker', async () => {
    const { provider: p } = provider()
    const result = await p.spawn({ cols: 80, rows: 24, isNewSession: true })
    await p.writeWithSettlement(result.id, 'echo ready\r')
    await waitFor(() => subprocess.write.mock.calls.length > 0)
    expect(subprocess.write).toHaveBeenCalledWith('echo ready\r')
  })

  it('does not spawn before durable admission and refuses a connection changed while waiting', async () => {
    let release!: () => void
    const admission = new Promise<void>((resolve) => {
      release = resolve
    })
    const admitted = vi.fn(() => admission)
    const adapter = new DaemonPtyAdapter({ guest: { ...guest(), admitIdentity: admitted } })
    adapters.push(adapter)
    const spawning = expect(
      adapter.spawn({ cols: 80, rows: 24, isNewSession: true })
    ).rejects.toThrow('Connection lost')
    await vi.waitFor(() => expect(admitted).toHaveBeenCalledOnce())
    expect(spawn).not.toHaveBeenCalled()
    for (const socket of connections) {
      socket.destroy()
    }
    await new Promise((resolve) => setImmediate(resolve))
    release()
    await spawning
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects desktop endpoint mixing and foreign paths before spawning', async () => {
    expect(() => new DaemonPtyAdapter({ guest: guest(), tokenPath: '/desktop/token' })).toThrow(
      'cannot use desktop'
    )
    const { provider: p } = provider()
    await expect(p.spawn({ cols: 80, rows: 24, cwd: 'C:\\Users\\guest' })).rejects.toThrow(
      'selected distro'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('preserves snapshot authority, event coordinates and owner identity across detach', async () => {
    const historyPath = join(harness.dir, 'guest-history')
    const { provider: first, adapter } = provider(historyPath)
    const result = await first.spawn({ cols: 91, rows: 31, isNewSession: true })
    const events: DaemonPtyRouterDataEvent[] = []
    const sourceEvents: DaemonPtyRouterDataEvent[] = []
    adapter.onData((event) => sourceEvents.push(event))
    first.onData((event) => events.push(event))
    const text = `IMPORTANT HEADER\r\n${'\rprogress'.repeat(14000)}`
    subprocess._simulateData(text)
    await waitFor(() => events.length > 0)
    const before = await first.getBufferSnapshot(result.id)
    expect(before).toMatchObject({
      data: expect.stringContaining('IMPORTANT HEADER'),
      cols: 91,
      rows: 31,
      seq: text.length,
      source: 'headless'
    })
    expect(events.every((event) => event.id === result.id)).toBe(true)
    expect(events).toEqual(sourceEvents.map((event) => ({ ...event, id: result.id })))
    expect(first.canProvideAuthoritativeBufferSnapshot(result.id)).toBe(true)
    await first.disconnectOnly()
    expect(subprocess.kill).not.toHaveBeenCalled()
    expect(await first.hasChildProcesses(result.id)).toBe(true)
    expect(await first.probePtyLiveness(result.id)).toBeNull()
    expect(
      await new HistoryReader(historyPath).detectColdRestoreState(
        toRelayWslPtyId(owner, result.id),
        { wslDistro: owner.distro }
      )
    ).toMatchObject({
      status: 'restored',
      restoreInfo: { cols: 91, rows: 31, cwd: '/home/guest' }
    })
    const { provider: second } = provider(historyPath)
    const attached = await second.spawn({
      cols: 91,
      rows: 31,
      sessionId: result.id,
      attachOnly: true
    })
    expect(attached.id).toBe(result.id)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(await second.getBufferSnapshot(result.id)).toEqual({ ...before, cwd: '/home/guest' })
    expect(await second.listProcesses()).toEqual([
      expect.objectContaining({ id: result.id, wslDistro: 'Ubuntu' })
    ])
  })

  it('reports connector loss for every pane without declaring exit or replacing shells', async () => {
    const { provider: p } = provider()
    const first = await p.spawn({ cols: 80, rows: 24, isNewSession: true })
    const second = await p.spawn({ cols: 80, rows: 24, isNewSession: true })
    const unavailable = vi.fn()
    const exited = vi.fn()
    p.onWriteUnavailable(unavailable)
    p.onExit(exited)
    connections[0]!.destroy()
    await waitFor(() => unavailable.mock.calls.length === 2)
    expect(unavailable.mock.calls.map(([event]) => event.id).sort()).toEqual(
      [first.id, second.id].sort()
    )
    expect(exited).not.toHaveBeenCalled()
    expect(subprocess.kill).not.toHaveBeenCalled()
    const attached = await p.spawn({
      cols: 80,
      rows: 24,
      sessionId: first.id,
      attachOnly: true
    })
    expect(attached.id).toBe(first.id)
    expect(spawn).toHaveBeenCalledTimes(2)
    await p.disconnectOnly()
    expect(unavailable).toHaveBeenCalledTimes(2)
  })

  it('publishes guest exit identity without losing the incarnation', async () => {
    const { provider: p } = provider()
    const result = await p.spawn({ cols: 80, rows: 24, isNewSession: true })
    const exited = vi.fn()
    p.onExit(exited)
    subprocess._simulateExit(17)
    await waitFor(() => exited.mock.calls.length === 1)
    expect(exited).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.id,
        code: 17,
        incarnationId: result.incarnationId
      })
    )
    expect(p.hasPty(result.id)).toBe(false)
  })

  it('rejects raw and foreign-owner attach IDs without contacting the owner', async () => {
    const { provider: p } = provider()
    await expect(
      p.spawn({ cols: 80, rows: 24, sessionId: 'raw', attachOnly: true })
    ).rejects.toThrow('encoded WSL')
    await expect(
      p.spawn({
        cols: 80,
        rows: 24,
        attachOnly: true,
        sessionId: toAppWslPtyId({ ...owner, relayBuildId: 'other-user' }, 'pty')
      })
    ).rejects.toThrow('different distro or relay build')
    expect(connectRoles).toEqual([])
  })
})
