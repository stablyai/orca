import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDaemonUtilityLauncherShim, type ShimParentPort } from './daemon-utility-launcher-shim'
import type { DaemonShimUpMessage, UtilityDaemonForkSpec } from './daemon-utility-fork-messages'

const READY_FIXTURE = join(__dirname, '__fixtures__', 'utility-shim-ready-daemon.cjs')
const EXITING_FIXTURE = join(__dirname, '__fixtures__', 'utility-shim-exiting-daemon.cjs')

type FakePort = ShimParentPort & {
  posted: DaemonShimUpMessage[]
  deliver(message: unknown): void
  started: boolean
  waitFor<K extends DaemonShimUpMessage['kind']>(
    kind: K,
    timeoutMs?: number
  ): Promise<Extract<DaemonShimUpMessage, { kind: K }>>
}

function createFakePort(): FakePort {
  const emitter = new EventEmitter()
  const posted: DaemonShimUpMessage[] = []
  const port: FakePort = {
    posted,
    started: false,
    on(_event, listener) {
      emitter.on('message', listener)
      return port
    },
    start() {
      port.started = true
    },
    postMessage(message) {
      posted.push(message as DaemonShimUpMessage)
      emitter.emit('posted', message)
    },
    deliver(message) {
      emitter.emit('message', { data: message })
    },
    waitFor(kind, timeoutMs = 10_000) {
      const existing = posted.find((message) => message.kind === kind)
      if (existing) {
        return Promise.resolve(existing as Extract<DaemonShimUpMessage, { kind: typeof kind }>)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for shim message ${kind}`)),
          timeoutMs
        )
        const onPosted = (message: DaemonShimUpMessage): void => {
          if (message.kind === kind) {
            clearTimeout(timer)
            emitter.off('posted', onPosted)
            resolve(message as Extract<DaemonShimUpMessage, { kind: typeof kind }>)
          }
        }
        emitter.on('posted', onPosted)
      })
    }
  }
  return port
}

function specFor(
  entryPath: string,
  overrides: Partial<UtilityDaemonForkSpec> = {}
): UtilityDaemonForkSpec {
  return {
    entryPath,
    args: ['--socket', '/fake/sock'],
    cwd: process.cwd(),
    env: { ...process.env, ORCA_SHIM_TEST: '1' },
    execPath: process.execPath,
    ...overrides
  }
}

type SpawnDouble = EventEmitter & {
  pid: number
  connected: boolean
  stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> }
  disconnect: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}

/** A daemon child that records the detach calls a real ChildProcess would take. */
function createSpawnDouble(): SpawnDouble {
  const child = new EventEmitter() as SpawnDouble
  const stderr = new EventEmitter() as SpawnDouble['stderr']
  stderr.destroy = vi.fn()
  child.pid = 4242
  child.connected = true
  child.stderr = stderr
  child.disconnect = vi.fn(() => {
    child.connected = false
  })
  child.unref = vi.fn()
  child.kill = vi.fn()
  return child
}

const spawnedPids: number[] = []

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
})

describe('daemon-utility-launcher-shim', () => {
  it('spawns the daemon detached as plain args on the provided binary', () => {
    const port = createFakePort()
    const child = new EventEmitter() as EventEmitter & { pid: number; stderr: null }
    child.pid = 4242
    child.stderr = null
    const spawn = vi.fn(() => child as never)
    runDaemonUtilityLauncherShim(port, spawn, () => {})

    expect(port.started).toBe(true)
    expect(port.posted[0]).toEqual({ kind: 'shim-ready' })

    const spec = specFor('/fake/daemon-entry.js')
    port.deliver({ kind: 'spawn', spec })
    expect(spawn).toHaveBeenCalledWith({
      program: process.execPath,
      args: ['/fake/daemon-entry.js', '--socket', '/fake/sock'],
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    expect(port.posted).toContainEqual({ kind: 'spawned', pid: 4242 })

    // A duplicate spawn request must not fork a second daemon.
    port.deliver({ kind: 'spawn', spec })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('reports a spawn failure and exits nonzero', () => {
    const port = createFakePort()
    const exit = vi.fn()
    runDaemonUtilityLauncherShim(
      port,
      () => {
        throw new Error('no binary')
      },
      exit
    )
    port.deliver({ kind: 'spawn', spec: specFor('/fake/daemon-entry.js') })
    expect(port.posted).toContainEqual({ kind: 'spawn-error', message: 'no binary' })
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('kills a pid-less child before exiting so the reported spawn failure leaves no orphan', () => {
    const port = createFakePort()
    const child = new EventEmitter() as EventEmitter & {
      pid: undefined
      stderr: null
      kill: ReturnType<typeof vi.fn>
    }
    child.stderr = null
    child.kill = vi.fn()
    const exit = vi.fn()
    runDaemonUtilityLauncherShim(port, () => child as never, exit)
    port.deliver({ kind: 'spawn', spec: specFor('/fake/daemon-entry.js') })
    expect(port.posted).toContainEqual({ kind: 'spawn-error', message: 'daemon child has no pid' })
    expect(child.kill).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })

  // The real-child case below proves release leaves the daemon alive; it cannot see
  // WHICH of the detach steps ran, so a dropped disconnect/destroy/unref stays green
  // there. Assert each one, and that release is idempotent.
  it('release detaches the daemon child without killing it, exactly once', () => {
    const port = createFakePort()
    const child = createSpawnDouble()
    const exit = vi.fn()
    runDaemonUtilityLauncherShim(port, () => child as never, exit)
    port.deliver({ kind: 'spawn', spec: specFor('/fake/daemon-entry.js') })

    port.deliver({ kind: 'release' })
    port.deliver({ kind: 'release' })

    expect(child.disconnect).toHaveBeenCalledOnce()
    expect(child.stderr.destroy).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('relays a daemon spawn error to the parent instead of dropping it', () => {
    const port = createFakePort()
    const child = createSpawnDouble()
    runDaemonUtilityLauncherShim(port, () => child as never, vi.fn())
    port.deliver({ kind: 'spawn', spec: specFor('/fake/daemon-entry.js') })

    child.emit('error', new Error('EPERM'))

    expect(port.posted).toContainEqual({ kind: 'daemon-error', message: 'EPERM' })
  })

  it('relays IPC readiness and stderr from a real daemon child', async () => {
    const port = createFakePort()
    const exit = vi.fn()
    runDaemonUtilityLauncherShim(port, undefined, exit)
    port.deliver({ kind: 'spawn', spec: specFor(READY_FIXTURE) })

    const spawned = await port.waitFor('spawned')
    spawnedPids.push(spawned.pid)
    expect(spawned.pid).toBeGreaterThan(0)

    const ready = await port.waitFor('daemon-message')
    expect(ready.message).toMatchObject({ type: 'ready', startedAtMs: 123 })

    const stderr = await port.waitFor('daemon-stderr')
    expect(stderr.text).toContain('utility-shim-fixture-stderr')

    // Release must detach without killing: the shim exits, the daemon stays.
    port.deliver({ kind: 'release' })
    expect(exit).toHaveBeenCalledWith(0)
    expect(() => process.kill(spawned.pid, 0)).not.toThrow()
  })

  it('relays the daemon exit code from a real child', async () => {
    const port = createFakePort()
    const exit = vi.fn()
    runDaemonUtilityLauncherShim(port, undefined, exit)
    port.deliver({ kind: 'spawn', spec: specFor(EXITING_FIXTURE) })

    const spawned = await port.waitFor('spawned')
    spawnedPids.push(spawned.pid)
    const exited = await port.waitFor('daemon-exit')
    expect(exited).toEqual({ kind: 'daemon-exit', code: 7, signal: null })
    // Exiting inside the relay would race process.exit against delivery of the
    // exit code the launcher reports as the startup-failure cause.
    expect(exit).not.toHaveBeenCalled()
  })

  it('releases a shim whose daemon already exited without posting a phantom daemon error', async () => {
    const port = createFakePort()
    const exit = vi.fn()
    runDaemonUtilityLauncherShim(port, undefined, exit)
    port.deliver({ kind: 'spawn', spec: specFor(EXITING_FIXTURE) })

    const spawned = await port.waitFor('spawned')
    spawnedPids.push(spawned.pid)
    await port.waitFor('daemon-exit')

    // Release still arrives here: the parent kills this shim on the exit relay,
    // but its own cleanup path calls disconnect() and kills are not instant.
    port.deliver({ kind: 'release' })
    expect(exit).toHaveBeenCalledWith(0)
    expect(port.posted.filter((message) => message.kind === 'daemon-error')).toEqual([])
  })
})
