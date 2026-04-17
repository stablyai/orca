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

function writeSessionFiles(
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

  describe('detectColdRestore', () => {
    it('returns restore info for unclean shutdown (endedAt is null)', () => {
      writeSessionFiles(dir, 'sess-1', makeMeta(), 'hello world\r\n$ ls\r\n')

      const info = reader.detectColdRestore('sess-1')
      expect(info).not.toBeNull()
      expect(info!.cwd).toBe('/home/user/project')
      expect(info!.cols).toBe(80)
      expect(info!.rows).toBe(24)
      expect(info!.scrollback).toContain('hello world')
    })

    it('returns null for clean shutdown (endedAt is set)', () => {
      writeSessionFiles(
        dir,
        'sess-1',
        makeMeta({ endedAt: '2026-04-15T12:00:00Z', exitCode: 0 }),
        'old output'
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
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'data')

      expect(reader.detectColdRestore('corrupt')).toBeNull()
    })

    it('returns empty scrollback when scrollback.bin is missing', () => {
      const sessionDir = join(dir, getHistorySessionDirName('no-scrollback'))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(makeMeta()))

      const info = reader.detectColdRestore('no-scrollback')
      expect(info).not.toBeNull()
      expect(info!.scrollback).toBe('')
    })
  })

  describe('TUI truncation', () => {
    it('truncates before last unmatched alternate-screen-on', () => {
      const scrollback = [
        'normal output\r\n',
        '\x1b[?1049h', // alt screen on (vim started)
        'vim content here'
        // No matching \x1b[?1049l — vim was running when daemon died
      ].join('')

      writeSessionFiles(dir, 'tui-sess', makeMeta(), scrollback)

      const info = reader.detectColdRestore('tui-sess')
      expect(info).not.toBeNull()
      expect(info!.scrollback).toContain('normal output')
      expect(info!.scrollback).not.toContain('vim content')
    })

    it('preserves content when alt-screen is properly closed', () => {
      const scrollback = [
        'before vim\r\n',
        '\x1b[?1049h', // alt screen on
        'vim stuff',
        '\x1b[?1049l', // alt screen off
        'after vim\r\n'
      ].join('')

      writeSessionFiles(dir, 'closed-tui', makeMeta(), scrollback)

      const info = reader.detectColdRestore('closed-tui')
      expect(info).not.toBeNull()
      expect(info!.scrollback).toContain('before vim')
      expect(info!.scrollback).toContain('after vim')
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
        // No close — daemon crashed while vim2 was open
      ].join('')

      writeSessionFiles(dir, 'multi-tui', makeMeta(), scrollback)

      const info = reader.detectColdRestore('multi-tui')
      expect(info).not.toBeNull()
      expect(info!.scrollback).toContain('line1')
      expect(info!.scrollback).toContain('line2')
      expect(info!.scrollback).not.toContain('vim2-still-running')
    })

    it('truncates at outermost unmatched alt-screen-on for nested sessions', () => {
      const scrollback = [
        'normal output\r\n',
        '\x1b[?1049h', // outer alt screen (e.g., tmux)
        'tmux content',
        '\x1b[?1049h', // inner alt screen (e.g., vim inside tmux)
        'vim inside tmux'
        // Neither closed — daemon crashed
      ].join('')

      writeSessionFiles(dir, 'nested-tui', makeMeta(), scrollback)

      const info = reader.detectColdRestore('nested-tui')
      expect(info).not.toBeNull()
      expect(info!.scrollback).toContain('normal output')
      expect(info!.scrollback).not.toContain('tmux content')
      expect(info!.scrollback).not.toContain('vim inside tmux')
    })

    it('returns full content when no alt-screen sequences', () => {
      writeSessionFiles(dir, 'plain', makeMeta(), 'just normal shell output\r\n')

      const info = reader.detectColdRestore('plain')
      expect(info!.scrollback).toBe('just normal shell output\r\n')
    })
  })

  describe('listRestorable', () => {
    it('lists sessions with unclean shutdown', () => {
      writeSessionFiles(dir, 'alive', makeMeta(), 'data')
      writeSessionFiles(dir, 'dead', makeMeta({ endedAt: '2026-04-15T12:00:00Z' }), 'data')

      const restorable = reader.listRestorable()
      expect(restorable).toEqual(['alive'])
    })

    it('returns empty array when no sessions exist', () => {
      expect(reader.listRestorable()).toEqual([])
    })

    it('returns decoded session ids for encoded on-disk directories', () => {
      const sessionId = 'repo-1::C:/Users/dev/feature'
      writeSessionFiles(dir, sessionId, makeMeta(), 'data')

      expect(reader.listRestorable()).toEqual([sessionId])
    })
  })
})
