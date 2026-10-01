import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { execFileCaptureToTermination } from './exec-file-capture'

describe('binary capture with a termination barrier', () => {
  it('preserves bytes that cannot round-trip through UTF-8', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x80])
    const result = await execFileCaptureToTermination(
      process.execPath,
      ['-e', `process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}))`],
      { encoding: 'buffer', timeout: 10_000 }
    )
    expect(result.stdout).toEqual(bytes)
    expect(result.stderr).toEqual(Buffer.alloc(0))
  })

  it('rejects binary output above the capture cap', async () => {
    await expect(
      execFileCaptureToTermination(
        process.execPath,
        ['-e', 'process.stdout.write(Buffer.alloc(9, 255))'],
        { encoding: 'buffer', maxBuffer: 8, timeout: 10_000 }
      )
    ).rejects.toThrow('more than 8 bytes')
  })

  it.skipIf(process.platform === 'win32').each(['abort', 'timeout'] as const)(
    'terminates descendants of a shim on %s',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'glab-binary-barrier-'))
      const marker = join(root, 'descendant-state')
      const script = `printf ready > "$1";trap 'printf signaled > "$1"' TERM;while :;do sleep 1;done`
      const controller = new AbortController()
      const pending = execFileCaptureToTermination(
        process.execPath,
        [
          '-e',
          `const {spawn}=require('node:child_process');` +
            `spawn('/bin/sh',${JSON.stringify(['-c', script, 'sh', marker])},{stdio:'ignore'});` +
            `setInterval(()=>{},1000)`
        ],
        {
          encoding: 'buffer',
          signal: controller.signal,
          timeout: mode === 'timeout' ? 5000 : 60_000
        }
      )
      const rejected = expect(pending).rejects.toMatchObject(
        mode === 'abort' ? { name: 'AbortError' } : { message: `${process.execPath} timed out.` }
      )
      try {
        await expect
          .poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 10_000 })
          .toBe('ready')
        if (mode === 'abort') {
          controller.abort()
        }
        await rejected
        expect(await readFile(marker, 'utf8')).toBe('signaled')
      } finally {
        controller.abort()
        await pending.catch(() => {})
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000
  )
})
