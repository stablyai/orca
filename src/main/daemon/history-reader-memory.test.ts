import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryReader } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import {
  TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
  TERMINAL_HISTORY_LOG_MAX_BYTES,
  TERMINAL_HISTORY_META_MAX_BYTES
} from './terminal-history-file-limits'
import {
  readTerminalHistoryJson,
  TERMINAL_HISTORY_JSON_MAX_STRUCTURAL_TOKENS
} from './terminal-history-file-reader'

const directories: string[] = []

function createSession(sessionId: string): { basePath: string; sessionPath: string } {
  const basePath = mkdtempSync(join(tmpdir(), 'orca-history-memory-'))
  directories.push(basePath)
  const sessionPath = join(basePath, getHistorySessionDirName(sessionId))
  mkdirSync(sessionPath, { recursive: true })
  writeFileSync(
    join(sessionPath, 'meta.json'),
    JSON.stringify({
      cwd: '/workspace',
      cols: 80,
      rows: 24,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      exitCode: null
    })
  )
  return { basePath, sessionPath }
}

function createSparseFile(path: string, bytes: number): void {
  const descriptor = openSync(path, 'w')
  ftruncateSync(descriptor, bytes)
  closeSync(descriptor)
}

function checkpoint(): string {
  return JSON.stringify({
    snapshotAnsi: 'safe checkpoint',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: '/workspace',
    cols: 80,
    rows: 24,
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    }
  })
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true })
  }
})

describe('terminal history restore memory limits', () => {
  it('falls back to a valid checkpoint when the incremental log is oversized', async () => {
    const { basePath, sessionPath } = createSession('oversized-log')
    writeFileSync(join(sessionPath, 'checkpoint.json'), checkpoint())
    createSparseFile(join(sessionPath, 'output.log'), TERMINAL_HISTORY_LOG_MAX_BYTES + 1)

    const restore = await new HistoryReader(basePath).detectColdRestore('oversized-log')
    expect(restore?.snapshotAnsi).toBe('safe checkpoint')
  })

  it('ignores oversized checkpoint and metadata files before parsing', async () => {
    const checkpointSession = createSession('oversized-checkpoint')
    createSparseFile(
      join(checkpointSession.sessionPath, 'checkpoint.json'),
      TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES + 1
    )
    expect(
      await new HistoryReader(checkpointSession.basePath).detectColdRestore('oversized-checkpoint')
    ).toBeNull()

    const metadataSession = createSession('oversized-metadata')
    createSparseFile(
      join(metadataSession.sessionPath, 'meta.json'),
      TERMINAL_HISTORY_META_MAX_BYTES + 1
    )
    expect(
      new HistoryReader(metadataSession.basePath).hasRestorableHistory('oversized-metadata')
    ).toBe(false)
  })

  it('rejects structurally amplified checkpoints before parsing', () => {
    const { sessionPath } = createSession('amplified-checkpoint')
    const checkpointPath = join(sessionPath, 'checkpoint.json')
    writeFileSync(
      checkpointPath,
      `{"snapshotAnsi":"","values":[${'0,'.repeat(TERMINAL_HISTORY_JSON_MAX_STRUCTURAL_TOKENS)}0]}`
    )
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      expect(() =>
        readTerminalHistoryJson(checkpointPath, TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES)
      ).toThrow(/JSON structure exceeds/)
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })
})
