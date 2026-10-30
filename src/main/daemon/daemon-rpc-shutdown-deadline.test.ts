import './mock-descendant-sweep'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { startDaemon, type DaemonHandle } from './daemon-main'
import {
  createDaemonShutdownDeadline,
  DAEMON_SHUTDOWN_TIMEOUT_MS
} from './daemon-shutdown-deadline'
import { getDaemonSocketPath } from './daemon-spawner'
import { TerminalHost } from './terminal-host'

let directory: string
let daemon: DaemonHandle
let client: DaemonClient
let releaseDisposal: (() => void) | undefined
let cancelDeadline: (() => void) | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-shutdown-deadline-'))
})

afterEach(async () => {
  cancelDeadline?.()
  releaseDisposal?.()
  client?.disconnect()
  vi.useRealTimers()
  await daemon?.shutdown()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

async function start(): Promise<{
  exit: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  requested: ReturnType<typeof vi.fn>
}> {
  const exit = vi.fn()
  const log = vi.fn()
  const deadline = createDaemonShutdownDeadline({ log, close: () => {} }, () => daemon, exit)
  cancelDeadline = deadline.cancel
  const requested = vi.fn(deadline.start)
  const socketPath = getDaemonSocketPath(directory)
  const tokenPath = join(directory, 'daemon.token')
  daemon = await startDaemon({
    socketPath,
    tokenPath,
    spawnSubprocess: () => {
      throw new Error('No PTY expected')
    },
    onShutdownRequested: requested,
    onRpcShutdown: deadline.cancel,
    onIdleShutdown: deadline.cancel
  })
  client = new DaemonClient({ socketPath, tokenPath })
  await client.ensureConnected()
  return { exit, log, requested }
}

it('bounds RPC shutdown before terminal disposal, even when disposal never settles', async () => {
  const { exit, log, requested } = await start()
  const stalled = new Promise<void>((resolve) => {
    releaseDisposal = resolve
  })
  const dispose = vi.spyOn(TerminalHost.prototype, 'dispose').mockReturnValue(stalled)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const shutdown = client.request('shutdown', { killSessions: true }, 30_000).catch(() => {})
  await vi.waitFor(() => expect(dispose).toHaveBeenCalled())
  expect(requested).toHaveBeenCalledOnce()

  // A second stop must not extend the first request's deadline.
  await vi.advanceTimersByTimeAsync(4_000)
  const secondShutdown = daemon.shutdown()
  await vi.advanceTimersByTimeAsync(DAEMON_SHUTDOWN_TIMEOUT_MS - 4_000)
  expect(exit).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledWith('shutdown-error', { message: 'shutdown timeout' })

  releaseDisposal?.()
  client.disconnect()
  await shutdown
  await secondShutdown
})

it('cancels the deadline when the RPC completes normally', async () => {
  const { exit, requested } = await start()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await client.request('shutdown', { killSessions: true })
  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0))
  expect(requested).toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(DAEMON_SHUTDOWN_TIMEOUT_MS)
  expect(exit).not.toHaveBeenCalled()
})

it.each(['disconnect', 'shutdownIfIdle'] as const)(
  'bounds idle retirement after %s when terminal disposal never settles',
  async (mode) => {
    const { exit, requested } = await start()
    const stalled = new Promise<void>((resolve) => {
      releaseDisposal = resolve
    })
    const dispose = vi.spyOn(TerminalHost.prototype, 'dispose').mockReturnValue(stalled)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    if (mode === 'shutdownIfIdle') {
      await expect(client.request('shutdownIfIdle', undefined)).resolves.toEqual({ retiring: true })
    }
    client.disconnect()
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled())
    expect(requested).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(DAEMON_SHUTDOWN_TIMEOUT_MS)
    expect(exit).toHaveBeenCalledOnce()
  }
)
