import { once } from 'node:events'
import { expect, it } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { executeCodexMaintenanceProcess } from './codex-maintenance-process'

function fixture() {
  const child = Object.assign(createFakePipedChild(), { exitCode: null, signalCode: null })
  let output = ''
  const pending = executeCodexMaintenanceProcess(
    { program: 'fake-updater' },
    (chunk) => {
      output += chunk.toString()
    },
    { spawn: () => child, platform: 'linux' }
  )
  return {
    child,
    output: () => output,
    finish: async () => {
      const ended = Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')])
      child.stdout.end()
      child.stderr.end()
      await ended
      Object.assign(child, { exitCode: 0 })
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
      await pending
      return output
    }
  }
}

it.each(['stdout', 'stderr'] as const)(
  'decodes a character split across %s chunks',
  async (name) => {
    const f = fixture()
    const bytes = Buffer.from('用')
    try {
      f.child[name].write(bytes.subarray(0, 1))
      expect(f.output()).toBe('')
      f.child[name].write(bytes.subarray(1, 2))
      expect(f.output()).toBe('')
      f.child[name].write(bytes.subarray(2))
      expect(f.output()).toBe('用')
    } finally {
      await f.finish()
    }
  }
)

it('keeps interleaved stdout and stderr byte sequences independent', async () => {
  const f = fixture()
  const stdout = Buffer.from('用')
  const stderr = Buffer.from('😀')
  try {
    f.child.stdout.write(stdout.subarray(0, 1))
    f.child.stderr.write(stderr.subarray(0, 2))
    expect(f.output()).toBe('')
    f.child.stdout.write(stdout.subarray(1))
    expect(f.output()).toBe('用')
    f.child.stderr.write(stderr.subarray(2))
    expect(f.output()).toBe('用😀')
  } finally {
    await f.finish()
  }
})

it('flushes incomplete sequences from each stream at end', async () => {
  const f = fixture()
  f.child.stdout.write(Buffer.from([0xe7]))
  f.child.stderr.write(Buffer.from([0xf0, 0x9f]))
  expect(await f.finish()).toBe('��')
})
