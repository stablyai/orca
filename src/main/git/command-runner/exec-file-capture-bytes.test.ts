import { describe, expect, it, vi } from 'vitest'
import { execFileCaptureToTermination } from './exec-file-capture'
import { createWslProcessGroupTermination } from '../wsl-process-group-termination'

const stdout = Buffer.from([0, 255, 128, 10])
const stderr = Buffer.from([128, 255, 0, 10])
const writeBytes =
  'process.stdout.write(Buffer.from([0,255,128,10]));process.stderr.write(Buffer.from([128,255,0,10]));'

describe('termination-barrier binary output', () => {
  it('preserves arbitrary bytes on both streams', async () => {
    await expect(
      execFileCaptureToTermination(process.execPath, ['-e', writeBytes], {
        encoding: 'buffer',
        timeout: 2_000
      })
    ).resolves.toEqual({ stdout, stderr })
  })

  it('encodes raw subprocess bytes as base64 without a UTF-8 round trip', async () => {
    await expect(
      execFileCaptureToTermination(process.execPath, ['-e', writeBytes], {
        encoding: 'base64',
        timeout: 2_000
      })
    ).resolves.toEqual({ stdout: stdout.toString('base64'), stderr: stderr.toString('base64') })
  })

  it('preserves bytes and the nonzero exit status on failure', async () => {
    await expect(
      execFileCaptureToTermination(process.execPath, ['-e', `${writeBytes}process.exitCode=7`], {
        encoding: 'buffer',
        timeout: 2_000
      })
    ).rejects.toMatchObject({ code: 7, stdout, stderr })
  })

  it('retains clipped raw bytes while rejecting overflow', async () => {
    await expect(
      execFileCaptureToTermination(process.execPath, ['-e', writeBytes], {
        encoding: 'buffer',
        maxBuffer: 3,
        timeout: 2_000
      })
    ).rejects.toMatchObject({
      code: 0,
      outputTruncated: true,
      stdout: stdout.subarray(0, 3),
      stderr: stderr.subarray(0, 3)
    })
  })

  it('strips the WSL process-group marker without decoding surrounding bytes', async () => {
    const termination = {
      ...createWslProcessGroupTermination('Ubuntu'),
      signal: async () => false,
      force: async () => false
    }
    const marker = termination
      .wrapGuestArgs(['git'])
      .join(' ')
      .match(/__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=/)?.[0]
    expect(marker).toBeDefined()
    const script = `${writeBytes}process.stderr.write(${JSON.stringify(`${marker}4321\r\n`)});process.stderr.write(Buffer.from([255,128]));`
    await expect(
      execFileCaptureToTermination(
        process.execPath,
        ['-e', script],
        { encoding: 'buffer', timeout: 2_000 },
        termination
      )
    ).resolves.toEqual({ stdout, stderr: Buffer.concat([stderr, Buffer.from([255, 128])]) })
  })

  it.each(['abort', 'timeout'] as const)(
    'retains raw output after %s and reports termination',
    async (mode) => {
      const controller = new AbortController()
      const onChildTerminated = vi.fn()
      const timeoutError = new Error('byte capture deadline')
      const pending = execFileCaptureToTermination(
        process.execPath,
        ['-e', `${writeBytes}setInterval(()=>{},1000)`],
        {
          encoding: 'buffer',
          timeout: mode === 'timeout' ? 200 : 2_000,
          signal: controller.signal,
          onChildTerminated,
          createTimeoutError: () => timeoutError
        }
      )
      const rejection = expect(pending).rejects.toMatchObject({
        ...(mode === 'abort' ? { name: 'AbortError' } : { message: timeoutError.message }),
        stdout,
        stderr
      })
      const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 200) : undefined
      try {
        await rejection
        await vi.waitFor(() => expect(onChildTerminated).toHaveBeenCalledOnce())
      } finally {
        clearTimeout(timer)
      }
    }
  )
})
