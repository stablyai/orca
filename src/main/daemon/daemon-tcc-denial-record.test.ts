import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseDaemonPidFile } from './daemon-pid-file-parse'

describe('daemon denial persistence', () => {
  it('survives a fresh module but never poisons a replacement incarnation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-tcc-denial-'))
    try {
      const pidPath = join(dir, 'daemon.pid')
      const record = parseDaemonPidFile(
        JSON.stringify({ pid: 123, startedAtMs: 456, launchNonce: 'a' })
      )!
      const first = await import('./daemon-tcc-denial-record')
      first.rememberDaemonTccDenial(record, pidPath)
      vi.resetModules()
      const fresh = await import('./daemon-tcc-denial-record')
      expect(fresh.hasDaemonTccDenial(record, pidPath)).toBe(true)
      expect(fresh.hasDaemonTccDenial({ ...record, launchNonce: 'b' }, pidPath)).toBe(false)
      expect(fresh.hasDaemonTccDenial({ ...record, startedAtMs: 789 }, pidPath)).toBe(false)
      expect(
        fresh.hasDaemonTccDenial({ ...record, startedAtMs: null, launchNonce: null }, pidPath)
      ).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
