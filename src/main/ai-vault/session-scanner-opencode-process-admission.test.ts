import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenCodeSqliteProcessClient } from './session-scanner-opencode-sqlite-process-client'

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: mocked.spawn }))

function child() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: vi.fn(),
    kill: vi.fn()
  })
  process.stdin.on('data', (data) => {
    const request = JSON.parse(data.toString())
    if (request.sessionId !== 'block') {
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, value: null })}\n`)
    }
  })
  return process
}
const args = { dbPath: '/home/ada/opencode.db', sessionId: 'session', platform: 'linux' as const }
const clients: ReturnType<typeof createOpenCodeSqliteProcessClient>[] = []
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose())
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function reader(beforeSpawn: (signal: AbortSignal) => Promise<void>, idleTeardownMs = 30_000) {
  mocked.spawn.mockImplementation(child)
  const result = createOpenCodeSqliteProcessClient({
    executable: 'wsl.exe',
    args: ['--exec', '/runtime', '/reader'],
    beforeSpawn,
    idleTeardownMs
  })
  clients.push(result)
  return result
}

describe('SQLite process launch admission', () => {
  it('does not probe a reader cancelled before admission starts', async () => {
    const admit = vi.fn(async () => {})
    const client = reader(admit)
    const cancellation = new AbortController()
    const pending = client.parse({ ...args, signal: cancellation.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled')
    cancellation.abort(new Error('cancelled'))
    await rejected
    await Promise.resolve()
    expect(admit).not.toHaveBeenCalled()
    expect(mocked.spawn).not.toHaveBeenCalled()
  })

  it('probes once per process, reuses it for every read, and reprobes after idle expiry', async () => {
    const admit = vi.fn(async () => {})
    const client = reader(admit, 15)
    for (let index = 0; index < 20; index++) {
      expect(await client.parse(args)).toBeNull()
    }
    expect(admit).toHaveBeenCalledOnce()
    expect(mocked.spawn).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(mocked.spawn.mock.results[0]?.value.kill).toHaveBeenCalled())
    await client.parse(args)
    expect(admit).toHaveBeenCalledTimes(2)
    expect(mocked.spawn).toHaveBeenCalledTimes(2)
  })

  it('blocks every queued respawn after the execution host stops', async () => {
    const admit = vi.fn(async () => {})
    const client = reader(admit)
    const active = client.parse({ ...args, sessionId: 'block' }).catch((error: unknown) => error)
    const queued = Array.from({ length: 4 }, () =>
      client.parse(args).catch((error: unknown) => error)
    )
    await vi.waitFor(() => expect(mocked.spawn).toHaveBeenCalledOnce())
    admit.mockRejectedValue(new Error('Distro is not running'))
    mocked.spawn.mock.results[0]?.value.emit('exit', 1)
    expect(await active).toMatchObject({ message: expect.stringContaining('exited') })
    for (const result of await Promise.all(queued)) {
      expect(result).toBeInstanceOf(Error)
    }
    expect(mocked.spawn).toHaveBeenCalledOnce()
    expect(admit.mock.calls.length).toBeGreaterThan(1)
  })

  it('rejects unavailable admission and cancels a pending probe without a late spawn', async () => {
    const refused = reader(async () => {
      throw new Error('Running state unavailable')
    })
    await expect(refused.parse(args)).rejects.toThrow('Running state unavailable')
    expect(mocked.spawn).not.toHaveBeenCalled()
    let finish = () => {}
    const admit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const waiting = reader(admit)
    const cancellation = new AbortController()
    const pending = waiting.parse({ ...args, signal: cancellation.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce())
    cancellation.abort(new Error('cancelled'))
    await rejected
    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocked.spawn).not.toHaveBeenCalled()
  })
})
