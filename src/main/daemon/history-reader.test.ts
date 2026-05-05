import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { HistoryReader } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import type { SessionMeta } from './history-manager'

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
    it('returns restore info from checkpoint.json for unclean shutdown', () => {
      writeSessionWithCheckpoint(dir, 'sess-1', makeMeta(), makeCheckpoint())

      const info = reader.detectColdRestore('sess-1')
      expect(info).not.toBeNull()
      expect(info!.cwd).toBe('/home/user/project')
      expect(info!.cols).toBe(80)
      expect(info!.rows).toBe(24)
      expect(info!.snapshotAnsi).toContain('hello world')
      expect(info!.rehydrateSequences).toBe('')
    })

    it('restores terminal modes from checkpoint', () => {
      const modes = {
        bracketedPaste: true,
        mouseTracking: false,
        applicationCursor: true,
        alternateScreen: false
      }
      writeSessionWithCheckpoint(dir, 'sess-1', makeMeta(), makeCheckpoint({ modes }))

      const info = reader.detectColdRestore('sess-1')
      expect(info!.modes.bracketedPaste).toBe(true)
      expect(info!.modes.applicationCursor).toBe(true)
    })

    it('restores rehydrateSequences from checkpoint', () => {
      writeSessionWithCheckpoint(
        dir,
        'sess-1',
        makeMeta(),
        makeCheckpoint({ rehydrateSequences: '\x1b[?2004h' })
      )

      const info = reader.detectColdRestore('sess-1')
      expect(info!.rehydrateSequences).toBe('\x1b[?2004h')
    })

    it('returns null for clean shutdown (endedAt is set)', () => {
      writeSessionWithCheckpoint(
        dir,
        'sess-1',
        makeMeta({ endedAt: '2026-04-15T12:00:00Z', exitCode: 0 }),
        makeCheckpoint()
      )

      expect(reader.detectColdRestore('sess-1')).toBeNull()
    })

    it('returns null for nonexistent session', () => {
      expect(reader.detectColdRestore('nonexistent')).toBeNull()
    })

    it('returns null for corrupt meta.json', () => {
      const sessionDir = join(dir, getHistorySessionDirName('corrupt'))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), 'not json')
      writeFileSync(join(sessionDir, 'checkpoint.json'), JSON.stringify(makeCheckpoint()))

      expect(reader.detectColdRestore('corrupt')).toBeNull()
    })

    it('falls back to scrollback.bin when checkpoint.json is corrupt', () => {
      const sessionDir = join(dir, getHistorySessionDirName('bad-cp'))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(makeMeta()))
      writeFileSync(join(sessionDir, 'checkpoint.json'), 'not json')
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'fallback data\r\n')

      const info = reader.detectColdRestore('bad-cp')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toBe('fallback data\r\n')
      expect(info!.rehydrateSequences).toBe('')
    })
  })

  describe('detectColdRestore — scrollback.bin fallback (backward compatibility)', () => {
    it('restores from scrollback.bin when checkpoint.json is absent', () => {
      writeSessionWithScrollback(dir, 'old-sess', makeMeta(), 'old format data\r\n')

      const info = reader.detectColdRestore('old-sess')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toContain('old format data')
      expect(info!.rehydrateSequences).toBe('')
      expect(info!.modes.bracketedPaste).toBe(false)
      expect(info!.modes.alternateScreen).toBe(false)
    })

    it('returns null when neither checkpoint.json nor scrollback.bin exist', () => {
      const sessionDir = join(dir, getHistorySessionDirName('no-data'))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(makeMeta()))

      expect(reader.detectColdRestore('no-data')).toBeNull()
    })

    it('truncates alt-screen from scrollback.bin fallback', () => {
      const scrollback = ['normal output\r\n', '\x1b[?1049h', 'vim content here'].join('')

      writeSessionWithScrollback(dir, 'tui-sess', makeMeta(), scrollback)

      const info = reader.detectColdRestore('tui-sess')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toContain('normal output')
      expect(info!.snapshotAnsi).not.toContain('vim content')
    })
  })

  describe('TUI truncation (scrollback.bin fallback path)', () => {
    it('preserves content when alt-screen is properly closed', () => {
      const scrollback = [
        'before vim\r\n',
        '\x1b[?1049h',
        'vim stuff',
        '\x1b[?1049l',
        'after vim\r\n'
      ].join('')

      writeSessionWithScrollback(dir, 'closed-tui', makeMeta(), scrollback)

      const info = reader.detectColdRestore('closed-tui')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toContain('before vim')
      expect(info!.snapshotAnsi).toContain('after vim')
    })

    it('handles multiple alt-screen cycles with last one unclosed', () => {
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

      const info = reader.detectColdRestore('multi-tui')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toContain('line1')
      expect(info!.snapshotAnsi).toContain('line2')
      expect(info!.snapshotAnsi).not.toContain('vim2-still-running')
    })

    it('truncates at outermost unmatched alt-screen-on for nested sessions', () => {
      const scrollback = [
        'normal output\r\n',
        '\x1b[?1049h',
        'tmux content',
        '\x1b[?1049h',
        'vim inside tmux'
      ].join('')

      writeSessionWithScrollback(dir, 'nested-tui', makeMeta(), scrollback)

      const info = reader.detectColdRestore('nested-tui')
      expect(info).not.toBeNull()
      expect(info!.snapshotAnsi).toContain('normal output')
      expect(info!.snapshotAnsi).not.toContain('tmux content')
      expect(info!.snapshotAnsi).not.toContain('vim inside tmux')
    })

    it('returns full content when no alt-screen sequences', () => {
      writeSessionWithScrollback(dir, 'plain', makeMeta(), 'just normal shell output\r\n')

      const info = reader.detectColdRestore('plain')
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
  })
})
