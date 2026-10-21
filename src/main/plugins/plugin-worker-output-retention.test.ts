import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { PLUGIN_LOG_KEY_LIMIT, PluginLogBuffer } from './plugin-log-buffer'
import { pipePluginWorkerOutput } from './plugin-worker-output-buffer'

async function heapAfterGc(): Promise<number> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
  return process.memoryUsage().heapUsed
}

async function endStream(stream: PassThrough): Promise<void> {
  const ended = once(stream, 'end')
  stream.end()
  await ended
}

function writeTail(stream: PassThrough, index: number): void {
  stream.write(`${' '.repeat(4 * 1024 * 1024)}\nretained output ${index}`)
}

function writeLine(stream: PassThrough, index: number, truncated: boolean): void {
  const prefix = String(index).padStart(4, '0')
  stream.write(
    truncated
      ? `${prefix}${'x'.repeat(64 * 1024)}\n`
      : `${' '.repeat(64 * 1024)}\nretained output ${prefix}\n`
  )
}

describe('plugin worker retained output', () => {
  it('bounds retained plugin keys while keeping the newest history', () => {
    const logs = new PluginLogBuffer()
    for (let index = 0; index < PLUGIN_LOG_KEY_LIMIT + 4; index += 1) {
      logs.append(`plugin-${index}`, 'info', `line-${index}`)
    }

    expect(logs.size).toBe(PLUGIN_LOG_KEY_LIMIT)
    expect(logs.get('plugin-0')).toEqual([])
    expect(logs.get(`plugin-${PLUGIN_LOG_KEY_LIMIT + 3}`)).toHaveLength(1)
  })

  it('keeps unfinished output after consuming a large chunk without retaining the parent', async () => {
    const lines: string[] = []
    const before = await heapAfterGc()
    const streams = Array.from({ length: 8 }, (_value, index) => {
      const stream = new PassThrough()
      pipePluginWorkerOutput(stream, 'info', (_level, line) => lines.push(line))
      writeTail(stream, index)
      return stream
    })

    expect((await heapAfterGc()) - before).toBeLessThan(2 * 1024 * 1024)
    expect(lines).toEqual([])
    for (const stream of streams) {
      await endStream(stream)
    }
    expect(lines).toEqual(Array.from({ length: 8 }, (_value, index) => `retained output ${index}`))
  })

  it.each([false, true])(
    'owns emitted log text without retaining consumed chunks (truncated=%s)',
    async (truncated) => {
      const logs = new PluginLogBuffer()
      const stream = new PassThrough()
      pipePluginWorkerOutput(stream, 'error', (level, line) => logs.append('plugin', level, line))
      const before = await heapAfterGc()
      for (let index = 0; index < 205; index++) {
        writeLine(stream, index, truncated)
      }
      await endStream(stream)

      // Compare text after the heap check: comparisons can flatten concatenated strings.
      expect((await heapAfterGc()) - before).toBeLessThan(5 * 1024 * 1024)
      expect(logs.get('plugin')).toHaveLength(200)
      for (const [index, row] of logs.get('plugin').entries()) {
        const prefix = String(index + 5).padStart(4, '0')
        expect(row.level).toBe('error')
        expect(row.line).toBe(
          truncated
            ? `${prefix}${'x'.repeat(8192 - 4 - '… [truncated]'.length)}… [truncated]`
            : `retained output ${prefix}`
        )
      }
    }
  )
})
