import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HistoryReader } from './history-reader'
import { encodeLogBatch, encodeLogHeader } from './terminal-history-log'

const loading = vi.hoisted(() => ({ count: 0 }))
vi.mock('./headless-emulator', async (importOriginal) => {
  loading.count += 1
  return importOriginal()
})

it('loads the real emulator only when eligible incremental history needs replay', async () => {
  const basePath = mkdtempSync(join(tmpdir(), 'orca-lazy-replay-'))
  try {
    const reader = new HistoryReader(basePath)
    expect(reader.listRestorable()).toEqual([])
    expect(reader.probeRestorableHistory('missing')).toEqual({ status: 'none' })
    expect(await reader.detectColdRestore('missing')).toBeNull()
    const session = join(basePath, 'session')
    mkdirSync(session)
    writeFileSync(
      join(session, 'meta.json'),
      JSON.stringify({
        cwd: '/workspace',
        cols: 80,
        rows: 24,
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    writeFileSync(join(session, 'output.log'), encodeLogHeader(0))
    expect(await reader.detectColdRestore('session')).toBeNull()
    expect(loading.count).toBe(0)

    writeFileSync(
      join(session, 'output.log'),
      Buffer.concat([
        encodeLogHeader(0),
        encodeLogBatch(1, [{ kind: 'output', data: 'restored output\r\n' }])
      ])
    )
    const restored = await reader.detectColdRestore('session')
    expect(restored?.snapshotAnsi).toContain('restored output')
    expect(loading.count).toBe(1)
  } finally {
    rmSync(basePath, { recursive: true, force: true })
  }
})
