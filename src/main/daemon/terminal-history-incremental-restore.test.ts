import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, truncateSync } from 'fs'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { HeadlessEmulator } from './headless-emulator'
import { encodeLogBatch, encodeLogHeader } from './terminal-history-log'
import { getHistorySessionDirName } from './history-paths'
import type { PendingOutputRecord } from './types'

// End-to-end coverage for incremental checkpoint persistence and cold-restore
// replay (issue #5096): HistoryManager appends take batches to output.log;
// HistoryReader replays checkpoint base + log tail through a scratch emulator.

const SESSION_ID = 'wt@@incremental-test'

let dir: string
let manager: HistoryManager
let reader: HistoryReader

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-incremental-restore-'))
  manager = new HistoryManager(dir)
  reader = new HistoryReader(dir)
  await manager.openSession(SESSION_ID, { cwd: '/home/user', cols: 80, rows: 24 })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function sessionFile(name: string): string {
  return join(dir, getHistorySessionDirName(SESSION_ID), name)
}

function snapshotOf(writes: string[], cols = 80, rows = 24) {
  const emulator = new HeadlessEmulator({ cols, rows })
  try {
    for (const data of writes) {
      emulator.writeSync(data)
    }
    return emulator.getSnapshot()
  } finally {
    emulator.dispose()
  }
}

describe('incremental terminal history restore', () => {
  it('replays appended output with no checkpoint base', async () => {
    await manager.appendIncrements(SESSION_ID, 1, [
      { kind: 'output', data: 'first line\r\n' },
      { kind: 'output', data: 'second line\r\n' }
    ])

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.scrollbackAnsi).toContain('first line')
    expect(restore!.scrollbackAnsi).toContain('second line')
    expect(restore!.cwd).toBe('/home/user')
  })

  it('replays checkpoint base plus log tail', async () => {
    await manager.checkpoint(SESSION_ID, snapshotOf(['from base\r\n']))
    await manager.appendIncrements(SESSION_ID, 1, [
      { kind: 'output', data: 'from tail after checkpoint\r\n' }
    ])

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.scrollbackAnsi).toContain('from base')
    expect(restore!.scrollbackAnsi).toContain('from tail after checkpoint')
  })

  it('ignores a stale log whose generation predates the checkpoint', async () => {
    await manager.appendIncrements(SESSION_ID, 1, [{ kind: 'output', data: 'stale tail\r\n' }])
    // Simulate a crash between checkpoint rename and log reset: write the
    // checkpoint with a newer generation while the gen-0 log stays on disk.
    const checkpoint = JSON.parse(JSON.stringify(snapshotOf(['base content\r\n'])))
    writeFileSync(
      sessionFile('checkpoint.json'),
      JSON.stringify({ ...checkpoint, cwd: '/home/user', generation: 1 })
    )

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.scrollbackAnsi).toContain('base content')
    expect(restore!.scrollbackAnsi).not.toContain('stale tail')
  })

  it('ignores a log when the checkpoint has no generation (pre-log format)', async () => {
    const checkpoint = JSON.parse(JSON.stringify(snapshotOf(['old format base\r\n'])))
    writeFileSync(
      sessionFile('checkpoint.json'),
      JSON.stringify({ ...checkpoint, cwd: '/home/user' })
    )
    writeFileSync(
      sessionFile('output.log'),
      Buffer.concat([
        encodeLogHeader(0),
        encodeLogBatch(1, [{ kind: 'output', data: 'orphan tail\r\n' }])
      ])
    )

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.scrollbackAnsi).toContain('old format base')
    expect(restore!.scrollbackAnsi).not.toContain('orphan tail')
  })

  it('falls back to the checkpoint when the log has a sequence gap', async () => {
    await manager.checkpoint(SESSION_ID, snapshotOf(['safe base\r\n']))
    const generation = 1
    writeFileSync(
      sessionFile('output.log'),
      Buffer.concat([
        encodeLogHeader(generation),
        encodeLogBatch(1, [{ kind: 'output', data: 'kept\r\n' }]),
        encodeLogBatch(3, [{ kind: 'output', data: 'after gap\r\n' }])
      ])
    )

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.scrollbackAnsi).toContain('safe base')
    expect(restore!.scrollbackAnsi).not.toContain('kept')
    expect(restore!.scrollbackAnsi).not.toContain('after gap')
  })

  it('replays the complete prefix of a torn final append', async () => {
    await manager.appendIncrements(SESSION_ID, 1, [{ kind: 'output', data: 'complete batch\r\n' }])
    await manager.appendIncrements(SESSION_ID, 2, [{ kind: 'output', data: 'torn batch\r\n' }])
    const logPath = sessionFile('output.log')
    truncateSync(logPath, readFileSync(logPath).length - 5)

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.scrollbackAnsi).toContain('complete batch')
    expect(restore!.scrollbackAnsi).not.toContain('torn batch')
  })

  it('applies resize records during replay', async () => {
    await manager.appendIncrements(SESSION_ID, 1, [
      { kind: 'output', data: 'before resize\r\n' },
      { kind: 'resize', cols: 132, rows: 40 },
      { kind: 'output', data: 'after resize\r\n' }
    ])

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.cols).toBe(132)
    expect(restore!.rows).toBe(40)
    expect(restore!.scrollbackAnsi).toContain('after resize')
  })

  it('applies clear records during replay', async () => {
    await manager.appendIncrements(SESSION_ID, 1, [
      { kind: 'output', data: 'cleared away\r\n' },
      { kind: 'clear' },
      { kind: 'output', data: 'survives clear\r\n' }
    ])

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.scrollbackAnsi).toContain('survives clear')
    expect(restore!.scrollbackAnsi).not.toContain('cleared away')
  })

  it('skips restorable content for sessions crashed inside the alt screen', async () => {
    await manager.appendIncrements(SESSION_ID, 1, [
      { kind: 'output', data: 'normal output\r\n\x1b[?1049halt screen content' }
    ])

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.modes.alternateScreen).toBe(true)
    // Why: the adapter skips cold restore when scrollbackAnsi is empty — alt
    // buffer contents must not replay into a fresh shell.
    expect(restore!.scrollbackAnsi).toBe('')
  })

  it('resets the log on checkpoint so old records are not replayed twice', async () => {
    await manager.appendIncrements(SESSION_ID, 1, [{ kind: 'output', data: 'pre-checkpoint\r\n' }])
    await manager.checkpoint(SESSION_ID, snapshotOf(['pre-checkpoint\r\n']))
    await manager.appendIncrements(SESSION_ID, 2, [{ kind: 'output', data: 'post-checkpoint\r\n' }])

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    const occurrences = restore!.scrollbackAnsi.split('pre-checkpoint').length - 1
    expect(occurrences).toBe(1)
    expect(restore!.scrollbackAnsi).toContain('post-checkpoint')
  })

  it('requests a full checkpoint when the log reaches its cap', async () => {
    const bigRecord: PendingOutputRecord = {
      kind: 'output',
      data: 'x'.repeat(2 * 1024 * 1024)
    }
    expect(await manager.appendIncrements(SESSION_ID, 1, [bigRecord])).toBe('ok')
    expect(await manager.appendIncrements(SESSION_ID, 2, [bigRecord])).toBe('ok')
    expect(await manager.appendIncrements(SESSION_ID, 3, [bigRecord])).toBe('needs-checkpoint')
    // Why: the rejected batch is subsumed by the snapshot the caller takes
    // next; checkpoint() resets the log for the new generation.
    await manager.checkpoint(SESSION_ID, snapshotOf(['compacted\r\n']))
    expect(
      await manager.appendIncrements(SESSION_ID, 4, [{ kind: 'output', data: 'fresh\r\n' }])
    ).toBe('ok')

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.scrollbackAnsi).toContain('compacted')
    expect(restore!.scrollbackAnsi).toContain('fresh')
  })

  it('openSession removes a stale log from a previous session with the same id', async () => {
    await manager.appendIncrements(SESSION_ID, 1, [{ kind: 'output', data: 'old session\r\n' }])
    expect(existsSync(sessionFile('output.log'))).toBe(true)

    await manager.openSession(SESSION_ID, { cwd: '/home/user', cols: 80, rows: 24 })
    expect(existsSync(sessionFile('output.log'))).toBe(false)
  })

  it('continues an existing log after a warm registerWriter', async () => {
    await manager.appendIncrements(SESSION_ID, 1, [{ kind: 'output', data: 'before relaunch\r\n' }])

    // Simulate app relaunch: a fresh HistoryManager attaches to the same dir.
    const relaunched = new HistoryManager(dir)
    relaunched.registerWriter(SESSION_ID)
    await relaunched.appendIncrements(SESSION_ID, 2, [
      { kind: 'output', data: 'after relaunch\r\n' }
    ])

    const restore = reader.detectColdRestore(SESSION_ID)
    expect(restore).not.toBeNull()
    expect(restore!.scrollbackAnsi).toContain('before relaunch')
    expect(restore!.scrollbackAnsi).toContain('after relaunch')
  })
})
