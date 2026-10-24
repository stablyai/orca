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
let daemon: DaemonHandle | undefined
let client: DaemonClient | undefined
let releaseDisposal: (() => void) | undefined
let cancelDeadline: (() => void) | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-idle-shutdown-deadline-'))
  daemon = undefined
  client = undefined
  releaseDisposal = undefined
  cancelDeadline = undefined
})

afterEach(async () => {
  releaseDisposal?.()
  client?.disconnect()
  vi.useRealTimers()
  await daemon?.shutdown()
  cancelDeadline?.()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

/** Connects a real client to a daemon with an observable shutdown deadline. */
async function start(): Promise<{
  exit: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  requested: ReturnType<typeof vi.fn>
  completed: ReturnType<typeof vi.fn>
}> {
  const exit = vi.fn()
  const log = vi.fn()
  const deadline = createDaemonShutdownDeadline({ log, close: () => {} }, exit)
  cancelDeadline = deadline.cancel
  const requested = vi.fn(deadline.start)
  const completed = vi.fn(deadline.cancel)
  const socketPath = getDaemonSocketPath(directory)
  const tokenPath = join(directory, 'daemon.token')
  daemon = await startDaemon({
    socketPath,
    tokenPath,
    spawnSubprocess: () => {
      throw new Error('No PTY expected')
    },
    onShutdownRequested: requested,
    onIdleShutdown: completed
  })
  client = new DaemonClient({ socketPath, tokenPath })
  await client.ensureConnected()
  return { exit, log, requested, completed }
}

/** Exercises either idle retirement route without creating a terminal. */
async function retire(mode: 'disconnect' | 'shutdownIfIdle'): Promise<void> {
  if (mode === 'shutdownIfIdle') {
    await expect(client?.request('shutdownIfIdle', undefined)).resolves.toEqual({ retiring: true })
  }
  client?.disconnect()
}

it.each(['disconnect', 'shutdownIfIdle'] as const)(
  'bounds idle shutdown after %s even when terminal disposal never settles',
  async (mode) => {
    const { exit, log, requested, completed } = await start()
    const stalled = new Promise<void>((resolve) => {
      releaseDisposal = resolve
    })
    const dispose = vi.spyOn(TerminalHost.prototype, 'dispose').mockReturnValue(stalled)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await retire(mode)
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled())
    expect(completed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DAEMON_SHUTDOWN_TIMEOUT_MS)
    expect(exit).toHaveBeenCalledOnce()
    expect(requested).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('shutdown-error', { message: 'shutdown timeout' })
  }
)

it.each(['disconnect', 'shutdownIfIdle'] as const)(
  'completes idle shutdown after %s without waiting for its deadline',
  async (mode) => {
    const { exit, completed } = await start()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await retire(mode)
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(DAEMON_SHUTDOWN_TIMEOUT_MS)
    expect(exit).not.toHaveBeenCalled()
  }
)
