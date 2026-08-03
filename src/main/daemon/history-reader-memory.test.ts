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
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryReader } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import {
  TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
  TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES,
  TERMINAL_HISTORY_LOG_MAX_BYTES,
  TERMINAL_HISTORY_META_MAX_BYTES
} from './terminal-history-file-limits'
import { readTerminalHistoryJson } from './terminal-history-file-reader'

const RETIRED_CHECKPOINT_READ_CAP_BYTES = 16 * 1024 * 1024

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

function checkpoint(overrides?: Record<string, unknown>): string {
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
    },
    scrollbackLines: 0,
    checkpointedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
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

  // Why: the read cap once sat at 16MiB while the writer stayed unbounded, so a big-scrollback
  // session cold-restored to an empty terminal — checkpoint nulled, and every fallback collapsed.
  it('restores a checkpoint larger than the retired 16MiB read cap', async () => {
    const { basePath, sessionPath } = createSession('large-checkpoint')
    const scrollbackAnsi = 'x'.repeat(RETIRED_CHECKPOINT_READ_CAP_BYTES + 1)
    writeFileSync(join(sessionPath, 'checkpoint.json'), checkpoint({ scrollbackAnsi }))

    const restore = await new HistoryReader(basePath).detectColdRestore('large-checkpoint')
    expect(restore?.scrollbackAnsi).toBe(scrollbackAnsi)
  })

  // Why the cap survives at all: it bounds a corrupt/runaway file, well above legitimate output.
  it('ignores oversized checkpoint and metadata files before parsing', async () => {
    const checkpointSession = createSession('oversized-checkpoint')
    const oversizedCheckpoint = join(checkpointSession.sessionPath, 'checkpoint.json')
    createSparseFile(oversizedCheckpoint, TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES + 1)
    // Why assert the reader directly too: detectColdRestore returns null for any unparseable
    // checkpoint, so it would stay green with the byte cap removed entirely.
    expect(() =>
      readTerminalHistoryJson(oversizedCheckpoint, TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES)
    ).toThrow(/File too large/)
    const checkpointReader = new HistoryReader(checkpointSession.basePath)
    expect(await checkpointReader.detectColdRestoreState('oversized-checkpoint')).toEqual({
      status: 'unreadable',
      sessionId: 'oversized-checkpoint'
    })
    expect(await checkpointReader.detectColdRestore('oversized-checkpoint')).toBeNull()

    const metadataSession = createSession('oversized-metadata')
    createSparseFile(
      join(metadataSession.sessionPath, 'meta.json'),
      TERMINAL_HISTORY_META_MAX_BYTES + 1
    )
    expect(
      new HistoryReader(metadataSession.basePath).hasRestorableHistory('oversized-metadata')
    ).toBe(true)
  })

  it('reports an oversized legacy scrollback as unreadable recovery', async () => {
    const { basePath, sessionPath } = createSession('oversized-legacy-scrollback')
    createSparseFile(
      join(sessionPath, 'scrollback.bin'),
      TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES + 1
    )

    expect(
      await new HistoryReader(basePath).detectColdRestoreState('oversized-legacy-scrollback')
    ).toEqual({
      status: 'unreadable',
      sessionId: 'oversized-legacy-scrollback'
    })
  })

  // Why: the retired 1M-structural-token pre-scan was reachable by ordinary content —
  // ~100k OSC-8 hyperlinks cross it, the assert threw, detectColdRestore swallowed it,
  // and the terminal restored blank. Same user-visible loss as the retired byte cap.
  it('restores a checkpoint carrying more OSC links than the retired structural-token cap', async () => {
    const { basePath, sessionPath } = createSession('many-osc-links')
    const oscLinks = Array.from({ length: 150_000 }, (_, index) => ({
      row: index,
      startCol: 0,
      endCol: 40,
      uri: `https://example.com/build/${index}`
    }))
    writeFileSync(join(sessionPath, 'checkpoint.json'), checkpoint({ oscLinks }))

    const restore = await new HistoryReader(basePath).detectColdRestore('many-osc-links')
    expect(restore?.snapshotAnsi).toBe('safe checkpoint')
    expect(restore?.oscLinks).toHaveLength(oscLinks.length)
  })

  // Why assert the reader directly too: detectColdRestore hides any reader throw as a
  // null checkpoint, so a reinstated pre-scan would stay invisible above.
  it('parses link-dense checkpoints without a structural pre-scan budget', () => {
    const { sessionPath } = createSession('link-dense-checkpoint')
    const checkpointPath = join(sessionPath, 'checkpoint.json')
    writeFileSync(checkpointPath, `{"snapshotAnsi":"","values":[${'0,'.repeat(2_000_000)}0]}`)
    expect(
      readTerminalHistoryJson<{ values: number[] }>(
        checkpointPath,
        TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES
      ).values
    ).toHaveLength(2_000_001)
  })

  // Why: the pre-scan also carried a 128-level nesting cap, and dropping it is only safe
  // because V8 parses JSON iteratively — depth costs heap, not stack. A future engine that
  // recursed would abort the daemon rather than throw into the callers' catch, so pin it.
  it('parses deeply nested checkpoints without the retired nesting-depth cap', () => {
    const { sessionPath } = createSession('deeply-nested-checkpoint')
    const checkpointPath = join(sessionPath, 'checkpoint.json')
    const depth = 50_000
    writeFileSync(
      checkpointPath,
      `{"snapshotAnsi":"","nested":${'['.repeat(depth)}${']'.repeat(depth)}}`
    )
    expect(
      readTerminalHistoryJson<{ nested: unknown[] }>(
        checkpointPath,
        TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES
      ).nested
    ).toHaveLength(1)
  })
})
