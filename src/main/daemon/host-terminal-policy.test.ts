import type * as FileSystem from 'node:fs/promises'
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTerminalPolicy, hostTerminalPolicyPath } from './host-terminal-policy'
import { SystemPtyLimit, parseLinuxPtyLimit } from './system-pty-limit'
import * as deadlines from './daemon-request-deadline'
import { HostTerminalLedger } from './host-terminal-ledger'
import { TerminalSpawnGate } from './terminal-spawn-gate'
import { isConfiguredTerminalLimit } from '../../shared/terminal-limit-policy'
import {
  DEFAULT_SPAWN_ADMISSION_LIMITS,
  type SpawnRequestFacts
} from '../../shared/host-spawn-admission'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FileSystem>()
  return { ...fs, writeFile: vi.fn(fs.writeFile), rename: vi.fn(fs.rename), rm: vi.fn(fs.rm) }
})

const fs = await vi.importActual<typeof FileSystem>('node:fs/promises')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const facts: SpawnRequestFacts = {
  clientId: 'user',
  declaredIntent: null,
  hasAgentSessionClaim: false,
  hasHistorySeed: false,
  deadlineAt: Number.POSITIVE_INFINITY
}
const system = () => new SystemPtyLimit(async () => 511)
const policies: HostTerminalPolicy[] = []
function createPolicy(
  ...args: ConstructorParameters<typeof HostTerminalPolicy>
): HostTerminalPolicy {
  const value = new HostTerminalPolicy(...args)
  policies.push(value)
  return value
}
const directories: string[] = []
afterEach(async () => {
  policies.splice(0).forEach((value) => value.dispose())
  vi.useRealTimers()
  await Promise.all(
    directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))
  )
  vi.resetAllMocks()
})

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-terminal-policy-'))
  directories.push(path)
  return path
}

describe('host terminal policy', () => {
  it('shares live raises and decreases across daemons and retains the policy after reconstruction', async () => {
    const root = await home()
    const path = hostTerminalPolicyPath(root, 'machine-a')
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const first = createPolicy(path, {}, system())
    const second = createPolicy(path, {}, system())
    const gate = (policy: HostTerminalPolicy, pid: number) =>
      new TerminalSpawnGate({
        log: vi.fn(),
        resolveMaximum: () => policy.admissionMaximum(),
        hostTerminals: new HostTerminalLedger({
          dir: join(root, 'ledger'),
          pid,
          maxTerminals: 256,
          isProcessAlive: () => true,
          log: vi.fn()
        })
      })
    const log = vi.fn()
    await Promise.all([first.start(log), second.start()])
    expect(log).not.toHaveBeenCalled()
    const desktop = gate(first, 100)
    const server = gate(second, 200)
    await first.save(1, () => true)
    const running = await desktop.admit(facts)
    running.commit('existing-shell', true)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(second.admissionMaximum()).toBe(first.admissionMaximum()))
    expect(() => server.admit(facts)).toThrow()
    await first.save(2, () => true)
    expect(first.admissionMaximum()).toBe(2)
    expect(second.admissionMaximum()).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(second.admissionMaximum()).toBe(2))
    const setup = await server.admit(facts)
    setup.commit('setup-script', true)
    await first.save(1, () => true)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(second.admissionMaximum()).toBe(first.admissionMaximum()))
    expect(() => server.admit(facts)).toThrow()
    expect(desktop.snapshot().terminals).toBe(1)
    expect(server.snapshot().terminals).toBe(1)
    const restarted = createPolicy(path, {}, system())
    await restarted.start()
    expect(restarted.admissionMaximum()).toBe(1)
    desktop.onSessionExit('existing-shell')
    expect(() => server.admit(facts)).toThrow()
    server.onSessionExit('setup-script')
    const next = await server.admit(facts)
    next.abandon()
    desktop.stopHostTerminals()
    server.stopHostTerminals()
  })

  it('caches the capped startup default, validates host capacity and preserves saved/environment priority', async () => {
    const root = await home()
    const path = hostTerminalPolicyPath(root, 'machine-a')
    expect(path).not.toBe(hostTerminalPolicyPath(root, 'machine-b'))
    expect(hostTerminalPolicyPath(root, null)).toBeNull()
    const policy = createPolicy(path, {}, system())
    await expect(policy.save(512, () => true)).rejects.toThrow('capacity')
    await policy.save(384, () => true)
    expect(await policy.status('nonce')).toMatchObject({
      maxTerminals: 384,
      source: 'saved',
      systemPtyLimit: 511
    })
    const read = vi.fn()
    const override = createPolicy(path, { ORCA_DAEMON_MAX_HOST_TERMINALS: '600' }, system(), read)
    await override.start()
    expect(read).not.toHaveBeenCalled()
    expect(await override.status('nonce')).toMatchObject({
      maxTerminals: 600,
      source: 'environment',
      editable: false
    })
    await expect(override.save(20, () => true)).rejects.toThrow('unavailable')
    const unidentified = createPolicy(null, {}, system())
    await unidentified.start()
    expect(await unidentified.status('nonce')).toMatchObject({ maxTerminals: 256, editable: false })
    await expect(unidentified.save(10, () => true)).rejects.toThrow()
    const reduced = createPolicy(path, {}, new SystemPtyLimit(async () => 128))
    await reduced.start()
    expect(await reduced.status('nonce')).toMatchObject({ maxTerminals: 384, systemPtyLimit: 128 })
    for (const [capacity, expected] of [
      [null, 256],
      [511, 256],
      [4096, 2048],
      [16384, 4096]
    ] as const) {
      const probe = vi.fn<() => Promise<number | null>>().mockResolvedValue(capacity)
      const defaults = createPolicy(null, {}, new SystemPtyLimit(probe))
      await defaults.start()
      expect(defaults.admissionMaximum()).toBe(expected)
      expect(defaults.admissionMaximum()).toBe(expected)
      expect(probe).toHaveBeenCalledOnce()
      probe.mockResolvedValue(128)
      expect(await defaults.status('nonce')).toMatchObject({
        maxTerminals: expected,
        source: 'default',
        systemPtyLimit: 128
      })
      expect(defaults.admissionMaximum()).toBe(expected)
    }
  })

  it('publishes slow startup, raises and decreases on settlement without background observers or transient health', async () => {
    vi.useFakeTimers()
    let saved = 384
    let latency = 300
    const read = vi.fn(() => {
      const maximum = saved
      // ast-grep-ignore: test-no-real-time-wait -- Fake timers model read latency across startup and refresh ticks.
      return new Promise<number>((resolve) => setTimeout(() => resolve(maximum), latency))
    })
    const value = createPolicy(join(await home(), 'policy.json'), {}, system(), read)
    const log = vi.fn()
    const observed = vi.spyOn(deadlines, 'awaitDaemonValueWithinCallerDeadline')
    const startup = value.start(log)
    expect(value.start()).toBe(startup)
    await vi.advanceTimersByTimeAsync(251)
    await startup
    expect(await value.status('nonce')).toMatchObject({ maxTerminals: 256, source: 'default' })
    expect((await value.status('nonce')).savedUnreadable).toBeUndefined()
    const observers = observed.mock.calls.length
    await vi.advanceTimersByTimeAsync(49)
    expect(value.admissionMaximum()).toBe(384)
    for (const maximum of [400, 300]) {
      saved = maximum
      await vi.advanceTimersToNextTimerAsync()
      await vi.advanceTimersByTimeAsync(300)
      expect(value.admissionMaximum()).toBe(maximum)
    }
    latency = 3_100
    saved = 350
    await vi.advanceTimersToNextTimerAsync()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(read).toHaveBeenCalledTimes(4)
    expect(value.admissionMaximum()).toBe(300)
    await vi.advanceTimersByTimeAsync(100)
    expect(value.admissionMaximum()).toBe(350)
    expect(observed).toHaveBeenCalledTimes(observers)
    saved = 2
    await vi.advanceTimersToNextTimerAsync()
    value.dispose()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(5)
    expect(value.admissionMaximum()).toBe(350)
    expect(log).not.toHaveBeenCalled()
  })

  it('bounds shared startup and retains one raw read/observer across ticks, admissions and independent saves', async () => {
    const path = join(await home(), 'policy.json')
    vi.useFakeTimers()
    const old = deferred<number | null>()
    const read = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue(384)
    const value = createPolicy(path, {}, system(), read)
    const observed = vi.spyOn(deadlines, 'awaitDaemonValueWithinCallerDeadline')
    const log = vi.fn()
    const startup = value.start(log)
    expect(value.start()).toBe(startup)
    await vi.advanceTimersByTimeAsync(251)
    await startup
    expect(await value.status('nonce')).toMatchObject({ maxTerminals: 256 })
    expect((await value.status('nonce')).savedUnreadable).toBeUndefined()
    expect(await value.save(384, () => true)).toMatchObject({ maxTerminals: 384 })
    expect(await value.save(400, () => true)).toMatchObject({ maxTerminals: 400 })
    expect(await value.save(384, () => true)).toMatchObject({ maxTerminals: 384 })
    const observers = observed.mock.calls.length
    const maximum = vi.fn(() => value.admissionMaximum())
    const gate = new TerminalSpawnGate({
      log: vi.fn(),
      mode: 'enforce',
      limits: { ...DEFAULT_SPAWN_ADMISSION_LIMITS, automaticConcurrency: 1 },
      resolveMaximum: maximum
    })
    for (const n of [30, 300]) {
      for (let i = 0; i < n; i++) {
        const lease = gate.admit(facts)
        if (lease instanceof Promise) {
          throw new Error('Admission must be synchronous')
        }
        lease.commit(`${n}-${i}`, true)
      }
      await vi.advanceTimersByTimeAsync(30_000)
      expect(read).toHaveBeenCalledOnce()
      expect(observed).toHaveBeenCalledTimes(observers)
    }
    expect(gate.snapshot().terminals).toBe(330)
    const automatic = { ...facts, declaredIntent: 'automatic-restore' as const }
    const first = await gate.admit(automatic)
    const waiting = gate.admit(automatic)
    expect(waiting).toBeInstanceOf(Promise)
    expect(gate.snapshot().waiting).toBe(1)
    const beforeWake = maximum.mock.calls.length
    first.commit('first', true)
    const next = await waiting
    next.commit('next', true)
    gate.onSessionExit('first')
    gate.onSessionExit('next')
    expect(maximum).toHaveBeenCalledTimes(beforeWake + 1)
    expect(maximum.mock.results.at(-1)?.value).toBe(384)
    expect(read).toHaveBeenCalledOnce()
    expect(gate.snapshot()).toMatchObject({
      terminals: 330,
      waiting: 0,
      inFlight: { automatic: 0 }
    })
    old.resolve(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(value.admissionMaximum()).toBe(384)
    expect(read).toHaveBeenCalledTimes(2)
    expect(observed).toHaveBeenCalledTimes(observers)
    expect(log).not.toHaveBeenCalled()
    value.dispose()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(2)
    const systemProbe = deferred<number | null>()
    const cold = createPolicy(null, {}, new SystemPtyLimit(() => systemProbe.promise))
    const initializing = cold.start()
    expect(cold.start()).toBe(initializing)
    await vi.advanceTimersByTimeAsync(1_101)
    await initializing
    expect(cold.admissionMaximum()).toBe(256)
    systemProbe.resolve(16384)
    await vi.advanceTimersByTimeAsync(0)
    expect(cold.admissionMaximum()).toBe(256)
  })

  it('retains last good through failures, fences stale reads against save and disposal, and recovers', async () => {
    const path = join(await home(), 'policy.json')
    vi.useFakeTimers()
    const held = deferred<number | null>()
    const read = vi.fn<() => Promise<number | null>>().mockResolvedValue(384)
    const value = createPolicy(path, {}, system(), read)
    const log = vi.fn()
    await value.start(log)
    read.mockRejectedValue(new SyntaxError('Invalid JSON'))
    await vi.advanceTimersByTimeAsync(6_000)
    read.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await vi.advanceTimersByTimeAsync(3_000)
    read.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(3_000)
    read.mockReturnValue(held.promise)
    await vi.advanceTimersByTimeAsync(3_251)
    expect(value.admissionMaximum()).toBe(384)
    expect(await value.status('nonce')).toMatchObject({
      maxTerminals: 384,
      source: 'saved',
      savedUnreadable: true,
      editable: true
    })
    expect(log).toHaveBeenCalledTimes(1)
    setTimeout(() => held.resolve(400), 300)
    read.mockResolvedValue(400)
    await vi.advanceTimersByTimeAsync(299)
    expect(value.admissionMaximum()).toBe(384)
    expect(log).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const recovered = await value.status('nonce')
    expect(recovered.maxTerminals).toBe(400)
    expect(recovered.savedUnreadable).toBeUndefined()
    expect(log.mock.calls.map(([event]) => event)).toEqual([
      'terminal-policy-read-failed',
      'terminal-policy-read-recovered'
    ])
    const rejected = deferred<number | null>()
    read.mockReturnValueOnce(rejected.promise)
    await vi.advanceTimersToNextTimerAsync()
    await expect(value.save(512, () => true)).rejects.toThrow('capacity')
    rejected.reject(new Error('obsolete denied read'))
    await vi.advanceTimersByTimeAsync(0)
    expect(value.admissionMaximum()).toBe(400)
    expect((await value.status('nonce')).savedUnreadable).toBeUndefined()
    expect(log).toHaveBeenCalledTimes(2)
    read.mockImplementationOnce(() => {
      throw new Error('actual synchronous loader failure')
    })
    await vi.advanceTimersToNextTimerAsync()
    expect((await value.status('nonce')).savedUnreadable).toBe(true)
    expect(log).toHaveBeenCalledTimes(3)
    const stale = deferred<number | null>()
    const between = deferred<number | null>()
    read
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(between.promise)
      .mockResolvedValue(384)
    await vi.advanceTimersToNextTimerAsync()
    const committing = deferred<void>()
    const release = deferred<void>()
    vi.mocked(rename).mockImplementationOnce(async (...args) => {
      committing.resolve()
      await release.promise
      await fs.rename(...args)
    })
    const save = value.save(384, () => true)
    await committing.promise
    stale.resolve(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(await value.status('nonce')).toMatchObject({ maxTerminals: 400, savedUnreadable: true })
    expect(log).toHaveBeenCalledTimes(3)
    release.resolve()
    expect(await save).toMatchObject({ maxTerminals: 384 })
    between.reject(new Error('obsolete pre-commit denial'))
    await vi.advanceTimersByTimeAsync(0)
    expect(value.admissionMaximum()).toBe(384)
    expect((await value.status('nonce')).savedUnreadable).toBeUndefined()
    expect(log).toHaveBeenCalledTimes(4)
    const late = deferred<number | null>()
    read.mockReturnValue(late.promise)
    await vi.advanceTimersToNextTimerAsync()
    value.dispose()
    const count = read.mock.calls.length
    late.reject(new Error('disposed read failure'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(count)
    expect(value.admissionMaximum()).toBe(384)
    expect(log).toHaveBeenCalledTimes(4)
  })

  it('expires staging without a late rename or orphan, and permits retry while cleanup stalls', async () => {
    const path = join(await home(), 'policy.json')
    const started = deferred<void>()
    const release = deferred<void>()
    const staged = deferred<void>()
    const cleaned = deferred<void>()
    const cleanup = deferred<void>()
    let expiredTemporary: Parameters<typeof writeFile>[0]
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      expiredTemporary = args[0]
      started.resolve()
      await release.promise
      await fs.writeFile(...args)
      staged.resolve()
    })
    vi.mocked(rm).mockImplementation(async (...args) => {
      if (args[0] !== expiredTemporary) {
        await cleanup.promise
      }
      await fs.rm(...args)
      if (args[0] === expiredTemporary) {
        cleaned.resolve()
      }
    })
    vi.useFakeTimers()
    const policy = createPolicy(path, {}, system())
    const save = policy.save(10, () => true)
    const failed = expect(save).rejects.toThrow('confirm')
    await started.promise
    await vi.advanceTimersByTimeAsync(2_001)
    await failed
    expect(rename).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
    vi.useRealTimers()
    expect(await policy.save(20, () => true)).toMatchObject({ maxTerminals: 20 })
    expect(await policy.save(30, () => true)).toMatchObject({ maxTerminals: 30 })
    release.resolve()
    await staged.promise
    await cleaned.promise
    cleanup.resolve()
    expect(await policy.admissionMaximum()).toBe(30)
    expect(rename).toHaveBeenCalledTimes(2)
    expect(await readdir(join(path, '..'))).toEqual(['policy.json'])
  })

  it.each(['completed', 'retryable failure'])(
    'keeps an expired issued rename unconfirmed: %s',
    async (outcome) => {
      const path = join(await home(), 'policy.json')
      const started = deferred<void>()
      const release = deferred<void>()
      const cleaned = deferred<void>()
      let issuedTemporary: Parameters<typeof rename>[0]
      vi.mocked(rename).mockImplementationOnce(async (...args) => {
        issuedTemporary = args[0]
        started.resolve()
        await release.promise
        if (outcome === 'retryable failure') {
          throw Object.assign(new Error('busy'), { code: 'EPERM' })
        }
        await fs.rename(...args)
      })
      vi.mocked(rm).mockImplementation(async (...args) => {
        await fs.rm(...args)
        if (args[0] === issuedTemporary) {
          cleaned.resolve()
        }
      })
      const reconciling = deferred<void>()
      const read = vi.fn(async (file: string) => {
        const saved: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
        if (
          !saved ||
          typeof saved !== 'object' ||
          !('maxTerminals' in saved) ||
          !isConfiguredTerminalLimit(saved.maxTerminals)
        ) {
          throw new Error('Invalid fixture')
        }
        reconciling.resolve()
        // ast-grep-ignore: test-no-real-time-wait -- Fake timers verify delayed actual-file reconciliation after an expired rename.
        await new Promise((resolve) => setTimeout(resolve, 300))
        return saved.maxTerminals
      })
      const policy = createPolicy(path, {}, system(), read)
      vi.useFakeTimers()
      const save = policy.save(10, () => true)
      const failed = expect(save).rejects.toThrow('confirm')
      await started.promise
      await vi.advanceTimersByTimeAsync(2_001)
      await failed
      expect(await policy.save(20, () => true)).toMatchObject({ maxTerminals: 20 })
      const platform = process.platform
      try {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
        release.resolve()
        await vi.advanceTimersByTimeAsync(0)
        await cleaned.promise
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      }
      expect(policy.admissionMaximum()).toBe(20)
      if (outcome === 'completed') {
        await reconciling.promise
        await vi.advanceTimersByTimeAsync(299)
        expect(policy.admissionMaximum()).toBe(20)
        await vi.advanceTimersByTimeAsync(1)
        expect(policy.admissionMaximum()).toBe(10)
        expect(read).toHaveBeenCalledOnce()
      } else {
        expect(read).not.toHaveBeenCalled()
      }
      expect(rename).toHaveBeenCalledTimes(2)
    }
  )

  it('reports Linux configured global and devpts capacity without subtracting namespace reserve', () => {
    expect(parseLinuxPtyLimit('4096\n', 'devpts /dev/pts devpts rw,max=128 0 0')).toBe(128)
    expect(parseLinuxPtyLimit('4096', 'devpts /dev/pts devpts rw 0 0')).toBe(4096)
    expect(parseLinuxPtyLimit('garbage', '')).toBeNull()
  })
})
