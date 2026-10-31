import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { createProviderLaunchReport } from './provider-launch-report'
import { spawnManagedProviderProcess } from './managed-provider-process'

function channel() {
  const incoming = new PassThrough(),
    outgoing = new PassThrough()
  let ack = ''
  outgoing.on('data', (bytes) => {
    ack += String(bytes)
  })
  const stream = Duplex.from({ readable: incoming, writable: outgoing })
  const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, stream] })
  const report = createProviderLaunchReport(child, true)
  return { incoming, stream, child, report, ack: () => ack }
}

it('commits and ACKs late success after initialize success retires semantic subscribers', async () => {
  const source = channel()
  const semantic: unknown[] = [],
    physical: unknown[] = []
  const unsubscribe = source.report.subscribe((record) => semantic.push(record))
  await Promise.resolve('initialized')
  unsubscribe()
  source.report.subscribe((record) => physical.push(record))
  source.incoming.write('{"kind":"spawned","pgid":4321}\n')
  expect(await source.report.done).toEqual({ kind: 'spawned', pgid: 4321 })
  expect(source.ack()).toBe('{"kind":"committed"}\n')
  expect(semantic).toEqual([])
  expect(physical).toEqual([{ kind: 'spawned', pgid: 4321 }])
  source.incoming.end()
  await source.report.closed
  expect(source.stream.destroyed).toBe(true)
})

it('retains a committed failure across cancellation and a conflicting late record', async () => {
  const source = channel()
  source.incoming.write(
    `${JSON.stringify({
      kind: 'failed',
      thrown: false,
      error: {
        name: 'Error',
        message: 'original launch failure',
        code: 'ENOENT',
        syscall: 'spawn agent',
        path: 'agent'
      }
    })}\n`
  )
  const committed = await source.report.done
  source.report.abandon()
  source.incoming.write('{"kind":"spawned","pgid":9999}\n')
  await source.report.closed
  expect(source.report.record).toBe(committed)
  expect(committed).toMatchObject({ kind: 'failed', error: { code: 'ENOENT', path: 'agent' } })
})

it('abandons startup but still commits/ACKs a later physical report', async () => {
  const source = channel()
  source.report.abandon()
  expect(await source.report.done).toBeNull()
  source.incoming.write('{"kind":"spawned","pgid":4321}\n')
  await new Promise<void>((resolve) => source.report.subscribe(() => resolve()))
  expect(source.ack()).toBe('{"kind":"committed"}\n')
  source.report.retire()
  await source.report.closed
})

it('retires a frozen partial report without root or peer frame completion', async () => {
  const source = channel()
  source.incoming.write('{"kind":"spawned","pgid":')
  source.report.abandon()
  source.report.retire()
  expect(await source.report.done).toBeNull()
  await source.report.closed
  expect(source.stream.destroyed).toBe(true)
  expect(source.child.listenerCount('message')).toBe(0)
  expect(source.child.listenerCount('exit')).toBe(0)
})

it.skipIf(process.platform === 'win32')(
  'knows real supervised ENOENT before root observation',
  async () => {
    const managed = spawnManagedProviderProcess(
      { command: '/orca-nonexistent-startup-agent', args: [], cwd: process.cwd() },
      { site: 'launch-report-test' }
    )
    const closed = new Promise<void>((resolve) => managed.child.once('close', () => resolve()))
    try {
      expect(await managed.launchReport.done).toMatchObject({
        kind: 'failed',
        thrown: false,
        error: { code: 'ENOENT', path: '/orca-nonexistent-startup-agent' }
      })
      expect(managed.spawnAbsence).toBe('executable')
      expect(managed.rootExitObserved).toBe(false)
      await closed
      expect(managed.child.exitCode).toBe(127)
    } finally {
      await managed.close()
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'unavailable ACK releases real stdout and normal wrapper completion',
  async () => {
    const managed = spawnManagedProviderProcess(
      {
        command: process.execPath,
        args: ['-e', "process.stdout.write('received output'); process.exit(0)"]
      },
      { site: 'unavailable-ack-test' }
    )
    let output = ''
    managed.child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    const closed = new Promise<void>((resolve) => managed.child.once('close', () => resolve()))
    managed.launchReport.retire()
    try {
      await closed
      expect(output).toBe('received output')
      expect(managed.child.exitCode).toBe(0)
    } finally {
      await managed.close()
    }
  }
)

it('delivers committed group evidence even when ACK write throws and retires its transport', async () => {
  const source = channel()
  const observed = vi.fn()
  source.report.subscribe(observed)
  vi.spyOn(source.stream, 'write').mockImplementation(() => {
    throw new Error('ACK unavailable')
  })
  source.incoming.write('{"kind":"spawned","pgid":4321}\n')
  expect(await source.report.done).toEqual({ kind: 'spawned', pgid: 4321 })
  await source.report.closed
  expect(observed).toHaveBeenCalledExactlyOnceWith({ kind: 'spawned', pgid: 4321 })
  expect(source.child.listenerCount('exit')).toBe(0)
})
