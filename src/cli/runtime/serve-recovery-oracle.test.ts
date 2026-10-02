import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { superviseForegroundServe } from './serve-update-supervisor'

class OracleChildProcess extends EventEmitter {
  kill = vi.fn()
  pid: number

  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

describe('Linux serve recovery oracle', () => {
  it('keeps the supervisor alive and replaces an unexpectedly exited main process', async () => {
    const crashed = new OracleChildProcess(4101)
    const replacement = new OracleChildProcess(4102)
    const spawnChild = vi.fn(() => replacement as never)
    const healthProbe = vi.fn(async () => ({
      healthy: true as const,
      runtimeId: 'runtime-replacement'
    }))

    const supervision = superviseForegroundServe({
      executable: '/opt/orca/orca',
      childArgs: ['--serve'],
      spawnOptions: {},
      spawnChild: spawnChild as never,
      child: crashed as never,
      handoffPath: null,
      expectedHandoff: null,
      healthProbe,
      recoverSingleton: vi.fn(async () => ({
        state: 'not-recoverable' as const,
        reason: 'missing_lock' as const
      })),
      sleep: async () => undefined,
      restartDelaysMs: [0],
      healthCheckIntervalMs: 60_000
    })

    crashed.emit('exit', 1, null)
    await vi.waitFor(() => expect(spawnChild).toHaveBeenCalledOnce())
    replacement.emit('message', {
      type: 'orca:serve-ready',
      version: '1.4.182',
      runtimeId: 'runtime-replacement',
      health: { websocket: 'ready', runtime: 'ready', graph: 'ready' }
    })
    await vi.waitFor(() => expect(healthProbe).toHaveBeenCalledOnce())
    replacement.emit('exit', 4, null)

    await expect(supervision).resolves.toBe(4)
  })
})
