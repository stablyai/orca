import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import { decodeLogHeader, LOG_HEADER_BYTES } from './terminal-history-log'
import {
  probeCheckpointGenerationHead,
  TerminalHistorySessionWriter
} from './terminal-history-session-writer'
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

  it('emits generation first so warm reattach can probe the checkpoint head', async () => {
    const manager = new HistoryManager(dir)
    await manager.openSession(SESSION_ID, { cwd: '/workspace', cols: 80, rows: 24 })
    await expect(manager.checkpoint(SESSION_ID, snapshot('first'))).resolves.toBe('committed')
    const checkpointPath = join(dir, getHistorySessionDirName(SESSION_ID), 'checkpoint.json')
    expect(probeCheckpointGenerationHead(checkpointPath)).toBe(1)
    await expect(manager.checkpoint(SESSION_ID, snapshot('second'))).resolves.toBe('committed')
    expect(probeCheckpointGenerationHead(checkpointPath)).toBe(2)
  })

  it('falls back to a full parse for legacy checkpoints without a leading generation', async () => {
    const sessionDir = join(dir, getHistorySessionDirName(SESSION_ID))
    mkdirSync(sessionDir, { recursive: true })
    const legacyCheckpoint = {
      snapshotAnsi: 'body',
      scrollbackAnsi: 'x'.repeat(4096),
      oscLinks: [],
      rehydrateSequences: '',
      cwd: null,
      cols: 80,
      rows: 24,
      modes: snapshot('modes-only').modes,
      scrollbackLines: 0,
      generation: 7
    }
    writeFileSync(join(sessionDir, 'checkpoint.json'), JSON.stringify(legacyCheckpoint))

    expect(probeCheckpointGenerationHead(join(sessionDir, 'checkpoint.json'))).toBeNull()

    const writer = new TerminalHistorySessionWriter(sessionDir, false)
    await writer.appendIncrements(0, [{ kind: 'output', data: 'warm' }])

    const logFd = openSync(join(sessionDir, 'output.log'), 'r')
    try {
      const logHeader = Buffer.alloc(LOG_HEADER_BYTES)
      readSync(logFd, logHeader, 0, LOG_HEADER_BYTES, 0)
      expect(decodeLogHeader(logHeader)).toBe(7)
    } finally {
      closeSync(logFd)
    }
  })

  it('rejects digit prefixes without a JSON token boundary and falls back to the full parse', async () => {
    const sessionDir = join(dir, getHistorySessionDirName(SESSION_ID))
    mkdirSync(sessionDir, { recursive: true })
    // Truncated head: a digit run with no closing token — the probe must not
    // accept "12" out of "123456789..." as a generation.
    writeFileSync(join(sessionDir, 'checkpoint.json'), '{"generation":123456789')
    expect(probeCheckpointGenerationHead(join(sessionDir, 'checkpoint.json'))).toBeNull()

    // A head whose digits are closed by a valid boundary (`,` next key) resolves
    // directly from the probe even though the body is truncated — boundary
    // validity, not body completeness, is what the probe certifies.
    writeFileSync(join(sessionDir, 'checkpoint.json'), '{"generation":12,"snapshotAnsi"')
    expect(probeCheckpointGenerationHead(join(sessionDir, 'checkpoint.json'))).toBe(12)
    expect(probeCheckpointGenerationHead(join(dir, 'missing', 'checkpoint.json'))).toBeNull()
  })
})
