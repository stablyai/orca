import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { HistoryReader } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import type { SessionMeta } from './history-manager'
import { encodeLogBatch, encodeLogHeader } from './terminal-history-log'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'history-reader-test-'))
}

function writeSessionWithScrollback(
  basePath: string,
  sessionId: string,
  meta: SessionMeta,
  scrollback: string
): void {
  const dir = join(basePath, getHistorySessionDirName(sessionId))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
  writeFileSync(join(dir, 'scrollback.bin'), scrollback)
}

function writeSessionWithCheckpoint(
  basePath: string,
  sessionId: string,
  meta: SessionMeta,
  checkpoint: Record<string, unknown>
): void {
  const dir = join(basePath, getHistorySessionDirName(sessionId))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify(checkpoint))
}

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    cwd: '/home/user/project',
    cols: 80,
    rows: 24,
    startedAt: '2026-04-15T10:00:00Z',
    endedAt: null,
    exitCode: null,
    ...overrides
  }
}

function makeCheckpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshotAnsi: 'hello world\r\n$ ls\r\n',
    scrollbackAnsi: 'hello world\r\n',
    rehydrateSequences: '',
    cwd: '/home/user/project',
    cols: 80,
    rows: 24,
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    },
    scrollbackLines: 0,
    checkpointedAt: '2026-04-15T11:00:00Z',
    ...overrides
  }
}

describe('HistoryReader', () => {
  let dir: string
  let reader: HistoryReader

  beforeEach(() => {
    dir = createTestDir()
    reader = new HistoryReader(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('detectColdRestore — checkpoint.json', () => {
    it('returns restore info from checkpoint.json for unclean shutdown', async () => {
      writeSessionWithCheckpoint(dir, 'sess-1', makeMeta(), makeCheckpoint())

      const info = await reader.detectColdRestore('sess-1')
      expect(info).not.toBeNull()
      expect(info!.cwd).toBe('/home/user/project')
      expect(info!.cols).toBe(80)
      expect(info!.rows).toBe(24)
      expect(info!.snapshotAnsi).toContain('hello world')
      expect(info!.rehydrateSequences).toBe('')
    })

    it('restores pre-limit 800-column checkpoint history', async () => {
      writeSessionWithCheckpoint(
        dir,
        'wide-checkpoint',
        makeMeta({ cols: 800 }),
        makeCheckpoint({ cols: 800 })
      )

      const info = await reader.detectColdRestore('wide-checkpoint')

      expect(info).toMatchObject({ cols: 800, rows: 24 })
    })

    it('restores checkpoint history at the exact accepted dimension ceiling', async () => {
      writeSessionWithCheckpoint(
        dir,
        'ceiling-checkpoint',
        makeMeta({ cols: 1_000, rows: 500 }),
        makeCheckpoint({ cols: 1_000, rows: 500 })
      )

      const info = await reader.detectColdRestore('ceiling-checkpoint')

      expect(info).toMatchObject({ cols: 1_000, rows: 500 })
    })

    it('restores terminal modes from checkpoint', async () => {
      const modes = {
        bracketedPaste: true,
        mouseTracking: false,
        applicationCursor: true,
        alternateScreen: false
      }
      writeSessionWithCheckpoint(dir, 'sess-1', makeMeta(), makeCheckpoint({ modes }))

      const info = await reader.detectColdRestore('sess-1')
      expect(info!.modes.bracketedPaste).toBe(true)
      expect(info!.modes.applicationCursor).toBe(true)
    })

    it('restores rehydrateSequences from checkpoint', async () => {
      writeSessionWithCheckpoint(
        dir,
        'sess-1',
        makeMeta(),
        makeCheckpoint({ rehydrateSequences: '\x1b[?2004h' })
      )

      const info = await reader.detectColdRestore('sess-1')
      expect(info!.rehydrateSequences).toBe('\x1b[?2004h')
    })

    it('restores OSC link ranges from checkpoint', async () => {
      const oscLinks = [{ row: 0, startCol: 6, endCol: 11, uri: 'https://example.com/issue/1234' }]
      writeSessionWithCheckpoint(dir, 'sess-1', makeMeta(), makeCheckpoint({ oscLinks }))

      const info = await reader.detectColdRestore('sess-1')
      expect(info!.oscLinks).toEqual(oscLinks)
    })

    it('returns null for clean shutdown (endedAt is set)', async () => {
      writeSessionWithCheckpoint(
        dir,
        'sess-1',
        makeMeta({ endedAt: '2026-04-15T12:00:00Z', exitCode: 0 }),
        makeCheckpoint()
      )

      expect(await reader.detectColdRestore('sess-1')).toBeNull()
    })

    it('returns null for nonexistent session', async () => {
      expect(await reader.detectColdRestore('nonexistent')).toBeNull()
    })

    it('returns null for corrupt meta.json', async () => {
      const sessionDir = join(dir, getHistorySessionDirName('corrupt'))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), 'not json')
      writeFileSync(join(sessionDir, 'checkpoint.json'), JSON.stringify(makeCheckpoint()))

      expect(await reader.detectColdRestore('corrupt')).toBeNull()
    })

    it.each([
      'null',
      '[]',
      '{}',
      JSON.stringify({ cwd: '/tmp', cols: 80, rows: 24 }),
      JSON.stringify(makeMeta({ cols: 1.5 })),
      JSON.stringify(makeMeta({ cols: 1_001 })),
      JSON.stringify(makeMeta({ rows: 501 }))
    ])('classifies structurally invalid metadata as unreadable: %s', async (metadata) => {
      const sessionDir = join(dir, getHistorySessionDirName('invalid-meta'))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), metadata)
      writeFileSync(join(sessionDir, 'checkpoint.json'), JSON.stringify(makeCheckpoint()))

      expect(reader.probeRestorableHistory('invalid-meta')).toEqual({
        status: 'unreadable',
        sessionId: 'invalid-meta'
      })
      expect(await reader.detectColdRestoreState('invalid-meta')).toEqual({
        status: 'unreadable',
        sessionId: 'invalid-meta'
      })
    })

    it.each(['null', '[]', '{}', JSON.stringify({ snapshotAnsi: 'only recovery copy' })])(
      'classifies structurally invalid checkpoint JSON as unreadable: %s',
      async (checkpoint) => {
        const sessionDir = join(dir, getHistorySessionDirName('invalid-checkpoint'))
        mkdirSync(sessionDir, { recursive: true })
        writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(makeMeta()))
        writeFileSync(join(sessionDir, 'checkpoint.json'), checkpoint)

        expect(await reader.detectColdRestoreState('invalid-checkpoint')).toEqual({
          status: 'unreadable',
          sessionId: 'invalid-checkpoint'
        })
      }
    )

    it.each([
      makeCheckpoint({ cols: 1.5 }),
      makeCheckpoint({ cols: 1_001 }),
      makeCheckpoint({ rows: 501 }),
      makeCheckpoint({ scrollbackLines: -1 }),
      makeCheckpoint({ modes: { bracketedPaste: false } })
    ])('classifies unsafe checkpoint fields as unreadable', async (checkpoint) => {
      const sessionId = 'unsafe-checkpoint'
      writeSessionWithCheckpoint(dir, sessionId, makeMeta(), checkpoint)

      expect(await reader.detectColdRestoreState(sessionId)).toEqual({
        status: 'unreadable',
        sessionId
      })
    })

    it('falls back to scrollback.bin when checkpoint.json is corrupt', async () => {
      const sessionDir = join(dir, getHistorySessionDirName('bad-cp'))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(makeMeta()))
      writeFileSync(join(sessionDir, 'checkpoint.json'), 'not json')
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'fallback data\r\n')

      const detection = await reader.detectColdRestoreState('bad-cp')
      expect(detection.status).toBe('restored')
      if (detection.status !== 'restored') {
        throw new Error('expected fallback restore')
      }
      expect(detection.restoreInfo.snapshotAnsi).toBe('fallback data\r\n')
      expect(detection.restoreInfo.rehydrateSequences).toBe('')
      expect(detection.hasUnreadableRecovery).toBe(true)
    })
  })

  it('replays incremental hostname OSC-7 with the same WSL context', async () => {
    writeSessionWithCheckpoint(dir, 'wsl-log', makeMeta(), makeCheckpoint({ generation: 7 }))
    const sessionDir = join(dir, getHistorySessionDirName('wsl-log'))
    writeFileSync(
      join(sessionDir, 'output.log'),
      Buffer.concat([
        encodeLogHeader(7),
        encodeLogBatch(1, [
          { kind: 'output', data: '\x1b]7;file://DESKTOP-ORCA/home/user/project\x07' }
        ])
      ])
    )

    const info = await reader.detectColdRestore('wsl-log', { wslDistro: 'Ubuntu' })

    expect(info?.cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\project')
  })

  describe('detectColdRestore — scrollback.bin fallback (backward compatibility)', () => {
    it('restores from scrollback.bin when checkpoint.json is absent', async () => {
      writeSessionWithScrollback(dir, 'old-sess', makeMeta(), 'old format data\r\n')

      const info = await reader.detectColdRestore('old-sess')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toContain('old format data')
      expect(info!.rehydrateSequences).toBe('')
      expect(info!.modes.bracketedPaste).toBe(false)
      expect(info!.modes.alternateScreen).toBe(false)
    })

    it('restores pre-limit 800-column legacy scrollback', async () => {
      writeSessionWithScrollback(
        dir,
        'wide-legacy',
        makeMeta({ cols: 800 }),
        'wide old format data\r\n'
      )

      const info = await reader.detectColdRestore('wide-legacy')

      expect(info).toMatchObject({ cols: 800, rows: 24 })
      expect(info!.snapshotAnsi).toContain('wide old format data')
    })

    it('returns null when neither checkpoint.json nor scrollback.bin exist', async () => {
      const sessionDir = join(dir, getHistorySessionDirName('no-data'))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(makeMeta()))

      expect(await reader.detectColdRestore('no-data')).toBeNull()
    })

    it('classifies a sole corrupt incremental log as unreadable', async () => {
      const sessionId = 'corrupt-log-only'
      const sessionDir = join(dir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(makeMeta()))
      writeFileSync(join(sessionDir, 'output.log'), 'not a terminal history log')

      expect(await reader.detectColdRestoreState(sessionId)).toEqual({
        status: 'unreadable',
        sessionId
      })
    })

    it('classifies an unsafe sole-log resize as unreadable', async () => {
      const sessionId = 'unsafe-log-resize'
      const sessionDir = join(dir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(makeMeta()))
      writeFileSync(
        join(sessionDir, 'output.log'),
        Buffer.concat([
          encodeLogHeader(0),
          encodeLogBatch(1, [{ kind: 'resize', cols: 1_001, rows: 24 }])
        ])
      )

      expect(await reader.detectColdRestoreState(sessionId)).toEqual({
        status: 'unreadable',
        sessionId
      })
    })

    it('replays a pre-limit 800-column incremental resize', async () => {
      const sessionId = 'wide-log-resize'
      const sessionDir = join(dir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(makeMeta({ cols: 800 })))
      writeFileSync(
        join(sessionDir, 'output.log'),
        Buffer.concat([
          encodeLogHeader(0),
          encodeLogBatch(1, [
            { kind: 'resize', cols: 800, rows: 24 },
            { kind: 'output', data: 'wide incremental data\r\n' }
          ])
        ])
      )

      const detection = await reader.detectColdRestoreState(sessionId)

      expect(detection.status).toBe('restored')
      if (detection.status === 'restored') {
        expect(detection.restoreInfo).toMatchObject({ cols: 800, rows: 24 })
        expect(detection.restoreInfo.snapshotAnsi).toContain('wide incremental data')
      }
    })

    it('flags a malformed current-generation log when checkpoint fallback restores', async () => {
      const sessionId = 'malformed-log-with-checkpoint'
      writeSessionWithCheckpoint(
        dir,
        sessionId,
        makeMeta(),
        makeCheckpoint({ generation: 1, snapshotAnsi: 'checkpoint fallback\r\n' })
      )
      const sessionDir = join(dir, getHistorySessionDirName(sessionId))
      writeFileSync(
        join(sessionDir, 'output.log'),
        Buffer.concat([
          encodeLogHeader(1),
          encodeLogBatch(1, [
            { kind: 'output', data: 'only post-checkpoint copy\r\n' },
            { kind: 'resize', cols: 1_001, rows: 24 }
          ])
        ])
      )

      const detection = await reader.detectColdRestoreState(sessionId)

      expect(detection.status).toBe('restored')
      if (detection.status === 'restored') {
        expect(detection.restoreInfo.snapshotAnsi).toContain('checkpoint fallback')
        expect(detection.hasUnreadableRecovery).toBe(true)
      }
    })

    it('flags a torn current-generation log while restoring its complete prefix', async () => {
      const sessionId = 'torn-log-with-checkpoint'
      writeSessionWithCheckpoint(
        dir,
        sessionId,
        makeMeta(),
        makeCheckpoint({ generation: 1, snapshotAnsi: 'checkpoint base\r\n' })
      )
      const fullLog = Buffer.concat([
        encodeLogHeader(1),
        encodeLogBatch(1, [{ kind: 'output', data: 'complete prefix\r\n' }]),
        encodeLogBatch(2, [{ kind: 'output', data: 'unique torn tail\r\n' }])
      ])
      writeFileSync(
        join(dir, getHistorySessionDirName(sessionId), 'output.log'),
        fullLog.subarray(0, -3)
      )

      const detection = await reader.detectColdRestoreState(sessionId)

      expect(detection.status).toBe('restored')
      if (detection.status === 'restored') {
        expect(detection.restoreInfo.snapshotAnsi).toContain('complete prefix')
        expect(detection.restoreInfo.snapshotAnsi).not.toContain('unique torn tail')
        expect(detection.hasUnreadableRecovery).toBe(true)
      }
    })

    it('truncates alt-screen from scrollback.bin fallback', async () => {
      const scrollback = ['normal output\r\n', '\x1b[?1049h', 'vim content here'].join('')

      writeSessionWithScrollback(dir, 'tui-sess', makeMeta(), scrollback)

      const info = await reader.detectColdRestore('tui-sess')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toContain('normal output')
      expect(info!.snapshotAnsi).not.toContain('vim content')
    })
  })

  describe('TUI truncation (scrollback.bin fallback path)', () => {
    it('preserves content when alt-screen is properly closed', async () => {
      const scrollback = [
        'before vim\r\n',
        '\x1b[?1049h',
        'vim stuff',
        '\x1b[?1049l',
        'after vim\r\n'
      ].join('')

      writeSessionWithScrollback(dir, 'closed-tui', makeMeta(), scrollback)

      const info = await reader.detectColdRestore('closed-tui')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toContain('before vim')
      expect(info!.snapshotAnsi).toContain('after vim')
    })

    it('handles multiple alt-screen cycles with last one unclosed', async () => {
      const scrollback = [
        'line1\r\n',
        '\x1b[?1049h',
        'vim1',
        '\x1b[?1049l',
        'line2\r\n',
        '\x1b[?1049h',
        'vim2-still-running'
      ].join('')

      writeSessionWithScrollback(dir, 'multi-tui', makeMeta(), scrollback)

      const info = await reader.detectColdRestore('multi-tui')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toContain('line1')
      expect(info!.snapshotAnsi).toContain('line2')
      expect(info!.snapshotAnsi).not.toContain('vim2-still-running')
    })

    it('truncates at outermost unmatched alt-screen-on for nested sessions', async () => {
      const scrollback = [
        'normal output\r\n',
        '\x1b[?1049h',
        'tmux content',
        '\x1b[?1049h',
        'vim inside tmux'
      ].join('')

      writeSessionWithScrollback(dir, 'nested-tui', makeMeta(), scrollback)

      const info = await reader.detectColdRestore('nested-tui')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toContain('normal output')
      expect(info!.snapshotAnsi).not.toContain('tmux content')
      expect(info!.snapshotAnsi).not.toContain('vim inside tmux')
    })

    it('returns full content when no alt-screen sequences', async () => {
      writeSessionWithScrollback(dir, 'plain', makeMeta(), 'just normal shell output\r\n')

      const info = await reader.detectColdRestore('plain')
      expect(info!.snapshotAnsi).toBe('just normal shell output\r\n')
    })
  })

  describe('listRestorable', () => {
    it('lists sessions with unclean shutdown', () => {
      writeSessionWithScrollback(dir, 'alive', makeMeta(), 'data')
      writeSessionWithScrollback(dir, 'dead', makeMeta({ endedAt: '2026-04-15T12:00:00Z' }), 'data')

      const restorable = reader.listRestorable()
      expect(restorable).toEqual(['alive'])
    })

    it('returns empty array when no sessions exist', () => {
      expect(reader.listRestorable()).toEqual([])
    })

    it('returns decoded session ids for encoded on-disk directories', () => {
      const sessionId = 'repo-1::C:/Users/dev/feature'
      writeSessionWithScrollback(dir, sessionId, makeMeta(), 'data')

      expect(reader.listRestorable()).toEqual([sessionId])
    })

    it('does not enumerate quarantined bundle metadata as live sessions', () => {
      writeSessionWithScrollback(dir, 'alive', makeMeta(), 'data')
      const quarantined = join(dir, '.recovery-quarantine', 'owner', 'bundle')
      mkdirSync(quarantined, { recursive: true })
      writeFileSync(join(quarantined, 'meta.json'), JSON.stringify(makeMeta()))

      expect(reader.listRestorable()).toEqual(['alive'])
    })

    it('skips malformed encoded session directories', () => {
      mkdirSync(join(dir, '%E0%A4%A'), { recursive: true })
      writeSessionWithScrollback(dir, 'alive', makeMeta(), 'data')

      expect(reader.listRestorable()).toEqual(['alive'])
    })
  })
})
