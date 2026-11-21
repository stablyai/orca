import { createFakeSpawnedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DirectProviderChild } from './direct-provider-child'
import type { ProviderSpawnSpec } from './provider-process-supervisor'

vi.mock('./provider-ownership-journal', () => ({
  providerOwnershipDirectory: () => '/private-test-state',
  publishProviderOwnership: async () => ({
    remove: async () => {},
    removeAfterNativeExit: async () => {}
  })
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

function createControl() {
  const control = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      if (chunk.toString() === 'leader-exit\n') {
        queueMicrotask(() => {
          control.push('group-absent\n')
          control.push(null)
        })
      }
      done()
    }
  })
  return control
}

function launch(index: number) {
  const parentPid = 7_000_000 + index * 3
  const raw = createFakeSpawnedChild(parentPid)
  const destination = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  raw.stdout = stdout
  raw.stderr = stderr
  const status = new PassThrough()
  const outcome = new PassThrough()
  const gate = new PassThrough()
  const control = createControl()
  Object.assign(raw, {
    stdio: [raw.stdin, raw.stdout, raw.stderr, control, gate, status, outcome, destination]
  })
  status.write(`${JSON.stringify({ leaderPid: parentPid + 1, watcherPid: parentPid + 2 })}\n`)
  gate.once('finish', () => status.end())
  const child = new DirectProviderChild(raw, spec, 'test-boot')
  // Connections install callbacks that retain their writer and pending requests.
  const connection: { child: DirectProviderChild; failures: Error[] } = { child, failures: [] }
  child.stdin.on('error', (error) => connection.failures.push(error))
  const errors: Error[] = []
  child.on('error', (error) => errors.push(error))
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  return {
    raw,
    child,
    connection,
    destination,
    gate,
    control,
    outcome,
    stdout,
    stderr,
    errors,
    closed
  }
}

async function finishChats(count: number) {
  const runs = Array.from({ length: count }, (_, index) => launch(index))
  await Promise.all(runs.map(({ child }) => child.ready))
  for (const [index, { stdout, stderr, outcome }] of runs.entries()) {
    stdout.end('final answer')
    stderr.end('final error')
    if (index % 2 === 0) {
      stdout.destroy()
      stderr.destroy()
    }
    outcome.end('{"code":0,"signal":null}\n')
  }
  await Promise.all(runs.map(({ closed }) => closed))
  for (const { raw, child, connection, destination, gate, errors } of runs) {
    expect(raw.exitCode).toBeNull() // H deliberately has not emitted exit.
    expect(child.exitCode).toBe(0)
    expect(raw.stdin).not.toBe(child.stdin)
    // Late native-parent transport failures must not reach the retired chat.
    raw.emit('error', new Error('late parent error'))
    gate.emit('error', new Error('late gate error'))
    expect(destination.destroyed).toBe(true)
    destination.emit('error', new Error('late stdin error'))
    expect(errors).toEqual([])
    expect(connection.failures).toEqual([])
    raw.stdout!.destroy()
    raw.stderr!.destroy()
  }
  return {
    parents: runs.map(({ raw }) => raw),
    refs: runs.map(({ connection }) => new WeakRef(connection))
  }
}

describe('finished CLI retention while native parents keep reaping', () => {
  it('releases 1500 finished connections while H stays live', async () => {
    const count = 1500
    const { parents, refs } = await finishChats(count)
    if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
      throw new Error('The test runner must enable --expose-gc')
    }
    for (let round = 0; round < 6; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      globalThis.gc()
    }
    expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0)
    expect(parents.every((raw) => raw.exitCode === null)).toBe(true)
  })
})

it('closes public input as soon as its native destination closes', async () => {
  const run = launch(2000)
  await run.child.ready
  run.destination.destroy()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(run.child.stdin.destroyed).toBe(true)
  run.stdout.end()
  run.stderr.end()
  run.outcome.end('{"code":0,"signal":null}\n')
  await run.closed
})

it.each(['EMFILE', 'ENFILE'])('reports a processless %s launch without throwing', async (code) => {
  const raw = createFakeSpawnedChild()
  for (const stream of [raw.stdin, raw.stdout, raw.stderr]) {
    stream.destroy()
  }
  // EMFILE/ENFILE return before Node assigns any PID or stdio properties.
  for (const name of ['pid', 'stdin', 'stdout', 'stderr', 'stdio']) {
    Object.defineProperty(raw, name, { value: undefined })
  }
  const child = new DirectProviderChild(raw, spec, 'test-boot')
  const errors: Error[] = []
  child.on('error', (error) => errors.push(error))
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const failure = Object.assign(new Error(`spawn native-parent ${code}`), { code })
  process.nextTick(() => {
    raw.emit('error', failure)
    raw.emit('close', -1, null)
  })

  await expect(child.ready).rejects.toMatchObject({ code, providerLaunchFailed: true })
  await closed
  expect(errors).toEqual([failure])
  expect(child.exitCode).toBe(-1)
  expect(child.stdin.destroyed).toBe(true)
  // A subsequent transport error must remain handled after retirement.
  raw.emit('error', new Error('late parent error'))
  expect(errors).toEqual([failure])
})
