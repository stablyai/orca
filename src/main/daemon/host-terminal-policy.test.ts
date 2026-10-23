import type * as FileSystem from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTerminalPolicy, hostTerminalPolicyPath } from './host-terminal-policy'
import { SystemPtyLimit, parseLinuxPtyLimit } from './system-pty-limit'
import { HostTerminalLedger } from './host-terminal-ledger'
import { TerminalSpawnGate } from './terminal-spawn-gate'
import type { SpawnRequestFacts } from '../../shared/host-spawn-admission'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FileSystem>()
  return { ...fs, writeFile: vi.fn(fs.writeFile), rename: vi.fn(fs.rename), rm: vi.fn(fs.rm) }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const facts: SpawnRequestFacts = {
  clientId: 'user',
  declaredIntent: null,
  hasAgentSessionClaim: false,
  hasHistorySeed: false,
  deadlineAt: Number.POSITIVE_INFINITY
}
const system = () => new SystemPtyLimit(async () => 511)
const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  const fs = await vi.importActual<typeof FileSystem>('node:fs/promises')
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
    const first = new HostTerminalPolicy(path, {}, system())
    const second = new HostTerminalPolicy(path, {}, system())
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
    const desktop = gate(first, 100)
    const server = gate(second, 200)
    await first.save(1, () => true)
    const running = await desktop.admit(facts)
    running.commit('existing-shell', true)
    await expect(server.admit(facts)).rejects.toThrow()
    await first.save(2, () => true)
    const setup = await server.admit(facts)
    setup.commit('setup-script', true)
    await first.save(1, () => true)
    await expect(server.admit(facts)).rejects.toThrow()
    expect(desktop.snapshot().terminals).toBe(1)
    expect(server.snapshot().terminals).toBe(1)
    const restarted = new HostTerminalPolicy(path, {}, system())
    expect(await restarted.admissionMaximum()).toBe(1)
    desktop.onSessionExit('existing-shell')
    await expect(server.admit(facts)).rejects.toThrow()
    server.onSessionExit('setup-script')
    const next = await server.admit(facts)
    next.abandon()
    desktop.stopHostTerminals()
    server.stopHostTerminals()
  })

  it('validates the host ceiling, preserves environment priority and never shares a missing machine identity', async () => {
    const root = await home()
    const path = hostTerminalPolicyPath(root, 'machine-a')
    expect(path).not.toBe(hostTerminalPolicyPath(root, 'machine-b'))
    expect(hostTerminalPolicyPath(root, null)).toBeNull()
    const policy = new HostTerminalPolicy(path, {}, system())
    await expect(policy.save(512, () => true)).rejects.toThrow('capacity')
    await policy.save(384, () => true)
    expect(await policy.status('nonce')).toMatchObject({
      maxTerminals: 384,
      source: 'saved',
      systemPtyLimit: 511
    })
    const override = new HostTerminalPolicy(
      path,
      { ORCA_DAEMON_MAX_HOST_TERMINALS: '600' },
      system()
    )
    expect(await override.status('nonce')).toMatchObject({
      maxTerminals: 600,
      source: 'environment',
      editable: false
    })
    await expect(override.save(20, () => true)).rejects.toThrow('unavailable')
    const unidentified = new HostTerminalPolicy(null, {}, system())
    expect(await unidentified.status('nonce')).toMatchObject({ maxTerminals: 256, editable: false })
    await expect(unidentified.save(10, () => true)).rejects.toThrow()
    const reduced = new HostTerminalPolicy(path, {}, new SystemPtyLimit(async () => 128))
    expect(await reduced.status('nonce')).toMatchObject({ maxTerminals: 384, systemPtyLimit: 128 })
    const defaults = new HostTerminalPolicy(null, {}, new SystemPtyLimit(async () => 128))
    expect(await defaults.status('nonce')).toMatchObject({ maxTerminals: 256, systemPtyLimit: 128 })
  })

  it('bounds admission wait while retaining one stalled underlying read', async () => {
    vi.useFakeTimers()
    const read = vi.fn(() => new Promise<number | null>(() => {}))
    const policy = new HostTerminalPolicy('/unreachable/terminal-policy', {}, system(), read)
    const attempts = Promise.all([policy.admissionMaximum(), policy.admissionMaximum()])
    await vi.advanceTimersByTimeAsync(251)
    expect(await attempts).toEqual([256, 256])
    const retry = policy.admissionMaximum()
    await vi.advanceTimersByTimeAsync(251)
    expect(await retry).toBe(256)
    expect(read).toHaveBeenCalledOnce()
  })

  it('drains a held admission snapshot after replacement before confirming the saved value', async () => {
    const path = join(await home(), 'policy.json')
    const old = deferred<number | null>()
    const read = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockImplementation(async () => JSON.parse(await readFile(path, 'utf8')).maxTerminals)
    const policy = new HostTerminalPolicy(path, {}, system(), read)
    const admission = policy.admissionMaximum()
    const replaced = deferred<void>()
    const fs = await vi.importActual<typeof FileSystem>('node:fs/promises')
    vi.mocked(rename).mockImplementationOnce(async (...args) => {
      await fs.rename(...args)
      replaced.resolve()
    })
    const save = policy.save(3, () => true, 'nonce')
    await replaced.promise
    await new Promise(setImmediate)
    old.resolve(2)
    expect(await admission).toBe(2)
    expect(await save).toMatchObject({ maxTerminals: 3, source: 'saved', daemonNonce: 'nonce' })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('expires staging without a late rename or orphan, and permits retry while cleanup stalls', async () => {
    const path = join(await home(), 'policy.json')
    const fs = await vi.importActual<typeof FileSystem>('node:fs/promises')
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
    const policy = new HostTerminalPolicy(path, {}, system())
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
      const fs = await vi.importActual<typeof FileSystem>('node:fs/promises')
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
      const policy = new HostTerminalPolicy(path, {}, system())
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
        await vi.advanceTimersByTimeAsync(100)
        await cleaned.promise
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      }
      expect(await policy.admissionMaximum()).toBe(outcome === 'completed' ? 10 : 20)
      expect(rename).toHaveBeenCalledTimes(2)
    }
  )

  it('reports Linux configured global and devpts capacity without subtracting namespace reserve', () => {
    expect(parseLinuxPtyLimit('4096\n', 'devpts /dev/pts devpts rw,max=128 0 0')).toBe(128)
    expect(parseLinuxPtyLimit('4096', 'devpts /dev/pts devpts rw 0 0')).toBe(4096)
    expect(parseLinuxPtyLimit('garbage', '')).toBeNull()
  })
})
