import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { drainDirectProviderOutput, pipeDirectProviderOutput } from './direct-provider-output-drain'

async function readText(stream: PassThrough): Promise<string> {
  let result = ''
  for await (const chunk of stream) {
    result += chunk.toString()
  }
  return result
}

afterEach(() => vi.useRealTimers())

describe('direct provider output retirement', () => {
  it('drains kernel-buffered final output after the owner loop stalls past its drain deadline', async () => {
    const raw = spawn(
      process.execPath,
      [
        '-e',
        String.raw`
      process.stdout.write('ready\n')
      process.stdin.once('data', () => {
        require('node:fs').writeSync(1, 'final answer 🐳\n')
        require('node:fs').writeSync(2, 'final error\n')
      })
      setInterval(() => {}, 60000)
    `
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const exited = new Promise<void>((resolve) => raw.once('exit', () => resolve()))
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    pipeDirectProviderOutput(raw, stdout, stderr)
    try {
      await new Promise<void>((resolve) => raw.stdout.once('data', () => resolve()))
      const drained = drainDirectProviderOutput(raw.stdout, raw.stderr, stdout, stderr)
      raw.stdin.write('go')
      // The inherited writer can flush while the owner cannot service its pipes or timers.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200)
      await drained
      await expect(Promise.all([readText(stdout), readText(stderr)])).resolves.toEqual([
        'ready\nfinal answer 🐳\n',
        'final error\n'
      ])
      expect(raw.stdout.destroyed).toBe(true)
      expect(raw.stderr.destroyed).toBe(true)
    } finally {
      raw.kill('SIGKILL')
      await exited
    }
  })

  it.each([150, 1500])(
    'retires inherited transports for %i exited providers while retaining unread output',
    async (count) => {
      vi.useFakeTimers()
      const runs = Array.from({ length: count }, () => {
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const outputStdout = new PassThrough()
        const outputStderr = new PassThrough()
        stdout.pipe(outputStdout, { end: false })
        stderr.pipe(outputStderr, { end: false })
        stdout.write('final answer 🐳\n')
        stderr.write('final error\n')
        const drained = drainDirectProviderOutput(stdout, stderr, outputStdout, outputStderr)
        return { stdout, stderr, outputStdout, outputStderr, drained }
      })
      await vi.runAllTimersAsync()
      await Promise.all(runs.map((run) => run.drained))
      for (const run of runs) {
        expect(run.stdout.destroyed).toBe(true)
        expect(run.stderr.destroyed).toBe(true)
        await expect(
          Promise.all([readText(run.outputStdout), readText(run.outputStderr)])
        ).resolves.toEqual(['final answer 🐳\n', 'final error\n'])
      }
    }
  )
})
