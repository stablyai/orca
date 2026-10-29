import { describe, expect, it } from 'vitest'
import { runProcess, runProcessSync } from './run-process'

describe('process byte capture', () => {
  it('preserves invalid UTF-8 and NUL bytes in async and sync capture', async () => {
    const spec = {
      program: process.execPath,
      args: [
        '-e',
        'process.stdout.write(Buffer.from([0,255,254,128,65]));process.stderr.write(Buffer.from([128,255,0,10]))'
      ],
      captureStdoutAsBytes: true,
      captureStderrAsBytes: true
    }
    for (const result of [await runProcess(spec), runProcessSync(spec)]) {
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '', outputTruncated: false })
      expect(result.stdoutBytes).toEqual(Buffer.from([0, 255, 254, 128, 65]))
      expect(result.stderrBytes).toEqual(Buffer.from([128, 255, 0, 10]))
    }
  })

  it('captures stderr bytes independently of ordinary text stdout', async () => {
    const spec = {
      program: process.execPath,
      args: ['-e', 'process.stdout.write("ok");process.stderr.write(Buffer.from([0,255,128,10]))'],
      captureStderrAsBytes: true
    }
    for (const result of [await runProcess(spec), runProcessSync(spec)]) {
      expect(result).toMatchObject({ code: 0, stdout: 'ok', stderr: '', outputTruncated: false })
      expect(result.stdoutBytes).toBeUndefined()
      expect(result.stderrBytes).toEqual(Buffer.from([0, 255, 128, 10]))
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
          'process.stdout.write(Buffer.alloc(12*1024*1024));process.stdout.write(Buffer.from([0,255,254,128]));process.stderr.write(Buffer.alloc(12*1024*1024));process.stderr.write(Buffer.from([128,254,255,0]))'
        ],
        maxOutputBytes: 4,
        captureStdoutAsBytes: true,
        captureStderrAsBytes: true,
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
      stderr: ''
    })
    expect(result.stdoutBytes).toEqual(Buffer.from([0, 255, 254, 128]))
    expect(result.stderrBytes).toEqual(Buffer.from([128, 254, 255, 0]))
  })
})
