import { ChildProcess } from 'node:child_process'
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

function launch(index: number) {
  const raw = new ChildProcess()
  raw.pid = 7_000_000 + index * 3
  raw.stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  raw.stdout = stdout
  raw.stderr = stderr
  const status = new PassThrough()
  const outcome = new PassThrough()
  const gate = new PassThrough()
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
  raw.stdio = [raw.stdin, raw.stdout, raw.stderr, control, gate, status, outcome]
  status.write(
    `${JSON.stringify({ leaderPid: raw.pid + 1, watcherPid: raw.pid + 2, bootId: 'test-boot' })}\n`
  )
  gate.once('finish', () => status.end())
  const child = new DirectProviderChild(raw, spec)
  // Connections install callbacks that retain their writer and pending requests.
  const connection = { child, failures: [] as Error[] }
  child.stdin.on('error', (error) => connection.failures.push(error))
  const errors: Error[] = []
  child.on('error', (error) => errors.push(error))
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  return { raw, child, connection, gate, control, outcome, stdout, stderr, errors, closed }
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
  for (const { raw, child, connection, gate, control, errors } of runs) {
    expect(raw.exitCode).toBeNull() // H deliberately has not emitted exit.
    expect(child.exitCode).toBe(0)
    expect(raw.stdout!.listenerCount('error')).toBe(0)
    expect(raw.stderr!.listenerCount('error')).toBe(0)
    expect(raw.stdin!.listenerCount('finish')).toBe(0)
    expect(raw.stdin).not.toBe(child.stdin)
    expect(raw.stdin!.listenerCount('error')).toBe(1) // Only the raw transport's sink.
    expect(raw.stdin!.listenerCount('close')).toBe(0)
    expect(raw.stdin!.listenerCount('unpipe')).toBe(0)
    expect(raw.stdout!.listenerCount('data')).toBe(0)
    expect(raw.stderr!.listenerCount('data')).toBe(0)
    expect(control.listenerCount('data')).toBe(0)
    expect(control.listenerCount('end')).toBe(0)
    // Late native-parent transport failures must not reach the retired chat.
    raw.emit('error', new Error('late parent error'))
    gate.emit('error', new Error('late gate error'))
    raw.stdin!.emit('error', new Error('late stdin error'))
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
  it.each([150, 1500])('releases %i finished connections while H stays live', async (count) => {
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
  run.raw.stdin!.destroy()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(run.child.stdin.destroyed).toBe(true)
  run.stdout.end()
  run.stderr.end()
  run.outcome.end('{"code":0,"signal":null}\n')
  await run.closed
})
