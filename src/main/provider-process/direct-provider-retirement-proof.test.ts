import { createFakeSpawnedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { Duplex, PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Journal from './provider-ownership-journal'
import type * as Rows from './provider-process-row-read'
import type * as Descendants from '../pty/process-retirement/pty-descendant-termination'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import { DirectProviderChild } from './direct-provider-child'

const probes = vi.hoisted(() => ({
  publish: vi.fn<typeof Journal.publishProviderOwnership>(),
  readRow: vi.fn<typeof Rows.readPosixProcessRow>(),
  readTable: vi.fn<typeof Descendants.readProcessTable>(),
  groupReap: vi.fn<typeof Journal.waitForProviderGroupReap>(),
  ownershipReap: vi.fn<typeof Journal.waitForProviderOwnershipReap>()
}))

vi.mock('./provider-ownership-journal', () => ({
  providerOwnershipDirectory: () => '/private-test-state',
  publishProviderOwnership: probes.publish,
  waitForProviderGroupReap: probes.groupReap,
  waitForProviderOwnershipReap: probes.ownershipReap
}))
vi.mock('./provider-process-row-read', async (importOriginal) => ({
  ...(await importOriginal<typeof Rows>()),
  readPosixProcessRow: probes.readRow
}))
vi.mock('../pty/process-retirement/pty-descendant-termination', async (importOriginal) => ({
  ...(await importOriginal<typeof Descendants>()),
  readProcessTable: probes.readTable
}))

const spec: ProviderSpawnSpec = {
  program: 'native-parent',
  args: [],
  command: 'agent',
  cwd: '.',
  env: {},
  supervised: true,
  detached: true,
  lifetime: 'session',
  closeRequest: 'stdin-end-and-sigterm',
  stdinEndGraceMs: 1_000,
  sigtermGraceMs: 3_000
}
const leader: Rows.ProviderProcessRow = {
  pid: 7_000_001,
  ppid: 7_000_000,
  pgid: 7_000_001,
  startedAt: '2026-11-15T11:00:00.000Z',
  startResolution: 'second'
}
const watcher = { ...leader, pid: 7_000_002, ppid: 7_000_001, pgid: 7_000_002 }

// Two check phases also flush the output drain's own setImmediate continuation.
async function flushContinuations(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function launch() {
  const captureEntered = Promise.withResolvers<void>()
  const captureReleased = Promise.withResolvers<void>()
  const ownershipEntered = Promise.withResolvers<void>()
  const ownershipResult = Promise.withResolvers<boolean>()
  const records = new Set<string>()
  const events: string[] = []
  const remove = vi.fn(async () => {
    events.push('remove')
    records.delete('provider-record')
  })
  const removeAfterNativeExit = vi.fn(async () => {
    events.push('removeAfterNativeExit')
    records.delete('provider-record')
  })
  probes.publish.mockImplementation(async () => {
    records.add('provider-record')
    events.push('publish')
    return { identity: { leader, watcher, pgid: leader.pid }, remove, removeAfterNativeExit }
  })
  probes.readRow.mockImplementation(async (pid) => (pid === leader.pid ? leader : 'unverifiable'))
  probes.readTable.mockImplementation(async () => {
    captureEntered.resolve()
    await captureReleased.promise
    return { rows: [leader], capturedAtMs: Date.now() }
  })
  probes.groupReap.mockResolvedValue(true)
  probes.ownershipReap.mockImplementation(async () => {
    ownershipEntered.resolve()
    return ownershipResult.promise
  })

  const raw = createFakeSpawnedChild(7_000_000)
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  raw.stdout = stdout
  raw.stderr = stderr
  const control = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done()
    }
  })
  const gate = new PassThrough()
  const status = new PassThrough()
  const outcome = new PassThrough()
  const destination = new PassThrough()
  Object.assign(raw, {
    stdio: [null, stdout, stderr, control, gate, status, outcome, destination]
  })
  status.write('{"leaderPid":7000001,"watcherPid":7000002}\n')
  gate.once('finish', () => status.end())
  const child = new DirectProviderChild(raw, spec, 'test-boot')
  child.stdout.resume()
  child.stderr.resume()
  const errors: Error[] = []
  child.on('error', (error) => errors.push(error))
  const closes: { code: number | null; signal: NodeJS.Signals | null; outcomeLost: boolean }[] = []
  child.on('close', (code, signal) => {
    events.push('close')
    closes.push({ code, signal, outcomeLost: child.outcomeLost })
  })

  return {
    child,
    control,
    records,
    events,
    errors,
    closes,
    remove,
    removeAfterNativeExit,
    finishParent(frame = '') {
      outcome.end(frame)
      stdout.end()
      stderr.end()
    },
    releaseCapture: () => captureReleased.resolve(),
    ownershipEntered: ownershipEntered.promise,
    refuseOwnership: () => ownershipResult.resolve(false),
    async loseParent() {
      await child.ready
      expect([...records]).toEqual(['provider-record'])
      outcome.end()
      stdout.end()
      stderr.end()
      await captureEntered.promise
      child.kill('SIGUSR2')
    },
    async cleanup() {
      captureReleased.resolve()
      ownershipResult.resolve(false)
      outcome.end()
      stdout.end()
      stderr.end()
      if (!control.destroyed && !control.readableEnded) {
        control.push(null)
      }
      try {
        await flushContinuations()
        await vi.runAllTimersAsync()
        await flushContinuations()
      } finally {
        for (const stream of [
          control,
          gate,
          status,
          outcome,
          destination,
          stdout,
          stderr,
          child.stdin,
          child.stdout,
          child.stderr
        ]) {
          stream.destroy()
        }
      }
    }
  }
}

describe.skipIf(process.platform === 'win32')('lost-parent watcher retirement proof', () => {
  let run: ReturnType<typeof launch> | undefined

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    vi.setSystemTime(new Date('2026-11-15T12:00:00.100Z'))
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' })
    })
  })

  afterEach(async () => {
    try {
      await run?.cleanup()
    } finally {
      run = undefined
      vi.clearAllTimers()
      vi.restoreAllMocks()
      vi.resetAllMocks()
      vi.useRealTimers()
    }
  })

  it('keeps close and ownership pending until the exact native frame also reaches EOF', async () => {
    run = launch()
    await run.loseParent()
    run.releaseCapture()
    await run.ownershipEntered
    run.refuseOwnership()
    await flushContinuations()

    expect(run.child.groupVerdict).toBe('exited')
    expect(run.closes).toEqual([])
    expect([...run.records]).toEqual(['provider-record'])
    expect(run.control.destroyed).toBe(false)

    run.control.push('group-absent\n')
    await flushContinuations()
    expect(run.closes).toEqual([])
    expect([...run.records]).toEqual(['provider-record'])
    expect(run.removeAfterNativeExit).not.toHaveBeenCalled()

    run.control.push(null)
    await flushContinuations()
    expect(run.events).toEqual(['publish', 'removeAfterNativeExit', 'close'])
    expect([...run.records]).toEqual([])
    expect(run.remove).not.toHaveBeenCalled()
    expect(run.closes).toEqual([{ code: null, signal: null, outcomeLost: true }])
    expect(run.errors).toEqual([])
  })

  it('retains unresolved tools when native completion arrives before the lost leader outcome', async () => {
    run = launch()
    await run.child.ready
    probes.readRow.mockResolvedValue('unverifiable')

    run.control.push('group-absent\n')
    run.control.push(null)
    await flushContinuations()
    run.finishParent()
    await vi.runAllTimersAsync()
    await flushContinuations()

    expect([...run.records]).toEqual(['provider-record'])
    expect(run.closes).toEqual([{ code: null, signal: null, outcomeLost: true }])
    expect(run.removeAfterNativeExit).not.toHaveBeenCalled()
    expect(run.errors).toEqual([])
  })

  it('releases normal completion without claiming intentionally detached tools', async () => {
    run = launch()
    await run.child.ready
    run.finishParent('{"code":0,"signal":null}\n')
    await flushContinuations()
    run.control.push('group-absent\n')
    run.control.push(null)
    await vi.runAllTimersAsync()
    await flushContinuations()

    expect([...run.records]).toEqual([])
    expect(run.closes).toEqual([{ code: 0, signal: null, outcomeLost: false }])
    expect(run.errors).toEqual([])
  })

  it.each([150, 1_500])(
    'leaves no ownership records after %s completion-first normal stops',
    async (count) => {
      const retained = new Set<string>()
      for (let index = 0; index < count; index++) {
        run = launch()
        await run.child.ready
        probes.readRow.mockResolvedValue(null)
        run.control.push('group-absent\n')
        run.control.push(null)
        await flushContinuations()
        run.finishParent('{"code":0,"signal":null}\n')
        await vi.runAllTimersAsync()
        await flushContinuations()
        for (const record of run.records) {
          retained.add(`${index}:${record}`)
        }
        expect(run.closes).toEqual([{ code: 0, signal: null, outcomeLost: false }])
        await run.cleanup()
      }
      expect([...retained]).toEqual([])
    }
  )

  it('releases speculative retention when a valid outcome arrives after the bounded wait', async () => {
    run = launch()
    await run.child.ready
    probes.readRow.mockResolvedValue(null)
    run.control.push('group-absent\n')
    run.control.push(null)
    await flushContinuations()
    await vi.advanceTimersByTimeAsync(2_000)
    expect([...run.records]).toEqual(['provider-record'])
    run.finishParent('{"code":0,"signal":null}\n')
    await vi.runAllTimersAsync()
    await flushContinuations()
    expect([...run.records]).toEqual([])
    expect(run.closes).toEqual([{ code: 0, signal: null, outcomeLost: false }])
  })

  it('spends R1 time inside the retirement bound measured from completed capture', async () => {
    run = launch()
    await run.loseParent()
    await vi.advanceTimersByTimeAsync(250)
    run.releaseCapture()
    await run.ownershipEntered
    await flushContinuations()
    await vi.advanceTimersByTimeAsync(1_000)
    run.refuseOwnership()
    await flushContinuations()

    expect(run.child.groupVerdict).toBe('exited')
    expect(run.closes).toEqual([])
    await vi.advanceTimersByTimeAsync(4_500)
    await flushContinuations()

    expect(run.closes).toEqual([{ code: null, signal: null, outcomeLost: true }])
    expect([...run.records]).toEqual(['provider-record'])
    expect(run.events).toEqual(['publish', 'close'])
    expect(run.removeAfterNativeExit).not.toHaveBeenCalled()
    expect(run.errors).toEqual([])
  })

  it.each(['group-absent\nextra\n', 'group-unverifiable\n'])(
    'retains ownership when EOF supplies no native absence proof (%j)',
    async (frame) => {
      run = launch()
      await run.loseParent()
      run.releaseCapture()
      await run.ownershipEntered
      run.refuseOwnership()
      await flushContinuations()
      expect(run.closes).toEqual([])
      expect([...run.records]).toEqual(['provider-record'])
      run.control.push(frame)
      run.control.push(null)
      await flushContinuations()

      expect(run.closes).toEqual([{ code: null, signal: null, outcomeLost: true }])
      expect([...run.records]).toEqual(['provider-record'])
      expect(run.events).toEqual(['publish', 'close'])
      expect(run.removeAfterNativeExit).not.toHaveBeenCalled()
      expect(run.errors).toEqual([])
    }
  )
})
