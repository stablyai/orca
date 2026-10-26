import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HistoryReader } from './history-reader'
import { encodeLogBatch, encodeLogHeader } from './terminal-history-log'

vi.mock('./headless-emulator', () => {
  throw new Error('replay chunk unavailable')
})

it('preserves the checkpoint and releases replay admission when the emulator cannot load', async () => {
  const basePath = mkdtempSync(join(tmpdir(), 'orca-replay-load-failure-'))
  try {
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
    writeFileSync(
      join(session, 'checkpoint.json'),
      JSON.stringify({
        snapshotAnsi: 'safe checkpoint',
        scrollbackAnsi: '',
        rehydrateSequences: '',
        cwd: '/workspace',
        cols: 80,
        rows: 24,
        generation: 0,
        modes: {
          bracketedPaste: false,
          mouseTracking: false,
          applicationCursor: false,
          alternateScreen: false
        },
        scrollbackLines: 0,
        checkpointedAt: '2026-01-01T00:00:00Z'
      })
    )
    writeFileSync(
      join(session, 'output.log'),
      Buffer.concat([
        encodeLogHeader(0),
        encodeLogBatch(1, [{ kind: 'output', data: 'new output\r\n' }])
      ])
    )
    const reader = new HistoryReader(basePath)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const restored = await reader.detectColdRestoreState('session')
      expect(restored).toMatchObject({
        status: 'restored',
        hasUnreadableRecovery: true,
        restoreInfo: { snapshotAnsi: 'safe checkpoint' }
      })
    }
  } finally {
    rmSync(basePath, { recursive: true, force: true })
  }
})
