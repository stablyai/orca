import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import type { TerminalSnapshot } from './types'

const SESSION_ID = 'bounded-checkpoint'

function snapshot(snapshotAnsi: string): TerminalSnapshot {
  return {
    snapshotAnsi,
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: '/workspace',
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    },
    cols: 80,
    rows: 24,
    scrollbackLines: 500
  }
}

describe('bounded terminal checkpoint writer', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'checkpoint-writer-bounds-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('trims oldest rows and commits a checkpoint within the reader byte contract', async () => {
    const maxBytes = 4_000
    const manager = new HistoryManager(dir, { checkpointMaxBytes: maxBytes })
    await manager.openSession(SESSION_ID, { cwd: '/workspace', cols: 80, rows: 24 })
    const lines = Array.from({ length: 500 }, (_, index) => `history-${index}\r\n`).join('')

    await expect(manager.checkpoint(SESSION_ID, snapshot(`${lines}NEWEST-MARKER`))).resolves.toBe(
      'committed'
    )

    const checkpointPath = join(dir, getHistorySessionDirName(SESSION_ID), 'checkpoint.json')
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'))
    expect(statSync(checkpointPath).size).toBeLessThanOrEqual(maxBytes)
    expect(checkpoint.snapshotAnsi).toContain('NEWEST-MARKER')
    expect(checkpoint.snapshotAnsi).not.toContain('history-0')
  })

  it('keeps serialization failures retryable without disabling the session', async () => {
    const manager = new HistoryManager(dir)
    await manager.openSession(SESSION_ID, { cwd: '/workspace', cols: 80, rows: 24 })
    await expect(manager.checkpoint(SESSION_ID, snapshot('stable'))).resolves.toBe('committed')
    const checkpointPath = join(dir, getHistorySessionDirName(SESSION_ID), 'checkpoint.json')
    const previous = readFileSync(checkpointPath, 'utf8')
    const invalid = snapshot('invalid')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    invalid.oscLinks = [circular as never]

    await expect(manager.checkpoint(SESSION_ID, invalid)).resolves.toBe('retryable')
    expect(manager.isSessionDisabled(SESSION_ID)).toBe(false)
    expect(readFileSync(checkpointPath, 'utf8')).toBe(previous)
    await expect(manager.checkpoint(SESSION_ID, snapshot('recovered'))).resolves.toBe('committed')
    expect(readFileSync(checkpointPath, 'utf8')).toContain('recovered')
  })

  it('persists parser-tail and title metadata when present', async () => {
    const manager = new HistoryManager(dir)
    await manager.openSession(SESSION_ID, { cwd: '/workspace', cols: 80, rows: 24 })

    await manager.checkpoint(SESSION_ID, {
      ...snapshot('body'),
      pendingEscapeTailAnsi: '\x1b[38;5;',
      lastTitle: 'Codex working'
    })

    const checkpointPath = join(dir, getHistorySessionDirName(SESSION_ID), 'checkpoint.json')
    expect(existsSync(checkpointPath)).toBe(true)
    expect(JSON.parse(readFileSync(checkpointPath, 'utf8'))).toMatchObject({
      pendingEscapeTailAnsi: '\x1b[38;5;',
      lastTitle: 'Codex working'
    })
  })

  it('replays a persisted parser tail before incremental log output', async () => {
    const manager = new HistoryManager(dir)
    await manager.openSession(SESSION_ID, { cwd: '/workspace', cols: 80, rows: 24 })
    await manager.checkpoint(SESSION_ID, {
      ...snapshot('base\r\n'),
      pendingEscapeTailAnsi: '\x1b[31'
    })
    await manager.appendIncrements(SESSION_ID, 1, [{ kind: 'output', data: 'mRED' }])

    const restored = await new HistoryReader(dir).detectColdRestore(SESSION_ID)

    expect(restored?.snapshotAnsi).toContain('\x1b[31mRED')
  })
})
