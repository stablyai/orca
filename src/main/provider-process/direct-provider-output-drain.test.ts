import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { drainDirectProviderOutput, pipeDirectProviderOutput } from './direct-provider-output-drain'

async function readText(stream: PassThrough): Promise<string> {
  let result = ''
  for await (const chunk of stream) {
    result += chunk.toString()
  }
  return result
}

// Only supervised POSIX children are drained; Windows spawns providers unsupervised.
describe.skipIf(process.platform === 'win32')('direct provider output retirement', () => {
  it('drains already-written output when its deadline expires before pipe readers run', async () => {
    const raw = spawn(
      process.execPath,
      [
        '-e',
        String.raw`
      require('node:fs').writeSync(1, 'final answer 🐳\n')
      require('node:fs').writeSync(2, 'final error\n')
      process.send('written')
      setInterval(() => {}, 60000)
    `
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
    )
    const exited = new Promise<void>((resolve) => raw.once('exit', () => resolve()))
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    try {
      // IPC proves both writes completed before any output reader is attached.
      await once(raw, 'message')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      pipeDirectProviderOutput(raw, stdout, stderr)
      const drained = drainDirectProviderOutput(raw.stdout, raw.stderr, stdout, stderr)
      vi.runOnlyPendingTimers()
      await drained
      await expect(Promise.all([readText(stdout), readText(stderr)])).resolves.toEqual([
        'final answer 🐳\n',
        'final error\n'
      ])
      expect(raw.stdout?.destroyed).toBe(true)
      expect(raw.stderr?.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
      raw.kill('SIGKILL')
      await exited
    }
  })
})
