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
  const errors: Error[] = []
  child.on('error', (error) => errors.push(error))
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  return { raw, child, gate, control, outcome, stdout, stderr, errors, closed }
}

describe('finished CLI retention while native parents keep reaping', () => {
  it.each([150, 1500])(
    'releases transport observers for %i finished chats before H exits',
    async (count) => {
      const runs = Array.from({ length: count }, (_, index) => launch(index))
      await Promise.all(runs.map(({ child }) => child.ready))
      for (const { stdout, stderr, outcome } of runs) {
        stdout.end('final answer')
        stderr.end('final error')
        outcome.end('{"code":0,"signal":null}\n')
      }
      await Promise.all(runs.map(({ closed }) => closed))
      for (const { raw, child, gate, control, errors } of runs) {
        expect(raw.exitCode).toBeNull() // H deliberately has not emitted exit.
        expect(child.exitCode).toBe(0)
        expect(raw.stdout!.listenerCount('error')).toBe(0)
        expect(raw.stderr!.listenerCount('error')).toBe(0)
        expect(raw.stdin!.listenerCount('finish')).toBe(0)
        expect(control.listenerCount('data')).toBe(0)
        expect(control.listenerCount('end')).toBe(0)
        // Late native-parent transport failures must not reach the retired chat.
        raw.emit('error', new Error('late parent error'))
        gate.emit('error', new Error('late gate error'))
        expect(errors).toEqual([])
        raw.stdout!.destroy()
        raw.stderr!.destroy()
      }
    }
  )
})
