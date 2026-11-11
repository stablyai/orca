import { runProcess } from '@orca/process-host'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WINDOWS_PIPE_ACCESS_JS } from './ssh-host-relay-windows-inventory'

describe('Windows relay pipe probe lifetime', () => {
  it('lets the actual Node probe exit after answering live and missing pipes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-pipe-'))
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\orca-test-${randomUUID()}`
        : join(dir, 'probe.sock')
    const missingPath = `${socketPath}-missing`
    const server = createServer((socket) => socket.on('error', () => socket.destroy()))
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const result = await runProcess({
        program: process.execPath,
        args: ['-e', WINDOWS_PIPE_ACCESS_JS, socketPath, missingPath],
        timeoutMs: 1500
      })
      expect(result.stdout).toBe(JSON.stringify({ [socketPath]: 'ok', [missingPath]: 'ENOENT' }))
      expect(result.timedOut).toBe(false)
      expect(result.code).toBe(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
