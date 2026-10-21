import { describe, expect, it } from 'vitest'
import { runProcess, runProcessSync } from './run-process'

describe('process byte capture', () => {
  it('preserves invalid UTF-8 and NUL bytes in async and sync capture', async () => {
    const spec = {
      program: process.execPath,
      args: ['-e', 'process.stdout.write(Buffer.from([0,255,254,128,65]))'],
      captureStdoutAsBytes: true
    }
    for (const result of [await runProcess(spec), runProcessSync(spec)]) {
      expect(result).toMatchObject({ code: 0, stdout: '', outputTruncated: false })
      expect(result.stdoutBytes).toEqual(Buffer.from([0, 255, 254, 128, 65]))
    }
  })

  it('stops an overflowing producer before its normal timeout', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write(Buffer.alloc(1000)); setInterval(() => {}, 1000)'],
      captureStdoutAsBytes: true,
      killOnOutputLimit: true,
      maxOutputBytes: 50,
      terminationBarrier: true,
      timeoutMs: 10_000
    })
    expect(result).toMatchObject({ outputTruncated: true, timedOut: false, stdout: '' })
    expect(result.stdoutBytes).toEqual(Buffer.alloc(50))
    expect(result.code === 0 && result.signal === null).toBe(false)
  })

  it('lets diagnostic streams exceed the cap while retaining their binary tails', async () => {
    const result = await runProcess(
      {
        program: process.execPath,
        args: [
          '-e',
          'process.stdout.write(Buffer.alloc(12*1024*1024));process.stdout.write(Buffer.from([0,255,254,128]));process.stderr.write(Buffer.alloc(12*1024*1024));process.stderr.write("done")'
        ],
        maxOutputBytes: 4,
        captureStdoutAsBytes: true,
        terminationBarrier: true,
        timeoutMs: 10_000
      },
      'tail'
    )
    expect(result).toMatchObject({
      code: 0,
      signal: null,
      timedOut: false,
      outputTruncated: true,
      stdout: '',
      stderr: 'done'
    })
    expect(result.stdoutBytes).toEqual(Buffer.from([0, 255, 254, 128]))
  })
})
