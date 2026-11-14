import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { drainDirectProviderOutput } from './direct-provider-output-drain'

async function readText(stream: PassThrough): Promise<string> {
  let result = ''
  for await (const chunk of stream) {
    result += chunk.toString()
  }
  return result
}

afterEach(() => vi.useRealTimers())

describe('direct provider output retirement', () => {
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
