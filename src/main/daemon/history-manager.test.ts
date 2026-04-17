import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync } from 'fs'
import { HistoryManager } from './history-manager'
import { getHistorySessionDirName } from './history-paths'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'history-mgr-test-'))
}

function sessionPath(baseDir: string, sessionId: string, file: string): string {
  return join(baseDir, getHistorySessionDirName(sessionId), file)
}

describe('HistoryManager', () => {
  let dir: string
  let mgr: HistoryManager

  beforeEach(() => {
    dir = createTestDir()
    mgr = new HistoryManager(dir)
  })

  afterEach(async () => {
    await mgr.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('openSession', () => {
    it('creates meta.json with session metadata', async () => {
      await mgr.openSession('sess-1', { cwd: '/home/user', cols: 80, rows: 24 })

      const metaPath = sessionPath(dir, 'sess-1', 'meta.json')
      expect(existsSync(metaPath)).toBe(true)

      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      expect(meta.cwd).toBe('/home/user')
      expect(meta.cols).toBe(80)
      expect(meta.rows).toBe(24)
      expect(meta.startedAt).toBeDefined()
      expect(meta.endedAt).toBeNull()
      expect(meta.exitCode).toBeNull()
    })

    it('creates scrollback.bin file', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 120, rows: 40 })

      const scrollbackPath = sessionPath(dir, 'sess-1', 'scrollback.bin')
      expect(existsSync(scrollbackPath)).toBe(true)
    })

    it('seeds scrollback with initial snapshot', async () => {
      await mgr.openSession('sess-1', {
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        initialScrollback: 'previous output\r\n'
      })

      const data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).toBe('previous output\r\n')
    })
  })

  describe('appendData', () => {
    it('appends PTY output to scrollback.bin', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      await mgr.appendData('sess-1', 'hello ')
      await mgr.appendData('sess-1', 'world\r\n')

      const data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).toBe('hello world\r\n')
    })

    it('ignores data for unknown sessions', async () => {
      // Should not throw
      await mgr.appendData('nonexistent', 'data')
    })

    it('persists the latest cwd from OSC-7 updates', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp/original', cols: 80, rows: 24 })

      await mgr.appendData('sess-1', '\x1b]7;file:///tmp/updated%20cwd\x07prompt$ ')

      const meta = mgr.readMeta('sess-1')
      expect(meta?.cwd).toBe('/tmp/updated cwd')
    })

    it('persists Windows UNC cwd updates from OSC-7', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })

      try {
        await mgr.openSession('sess-1', { cwd: 'C:\\start', cols: 80, rows: 24 })
        await mgr.appendData('sess-1', '\x1b]7;file://server/share/project\x07')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      const meta = mgr.readMeta('sess-1')
      expect(meta?.cwd).toBe('\\\\server\\share\\project')
    })
  })

  describe('closeSession', () => {
    it('writes endedAt and exitCode to meta.json', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.closeSession('sess-1', 0)

      const meta = JSON.parse(readFileSync(sessionPath(dir, 'sess-1', 'meta.json'), 'utf-8'))
      expect(meta.endedAt).toBeDefined()
      expect(meta.exitCode).toBe(0)
    })

    it('flushes pending data before closing', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.appendData('sess-1', 'final output')
      await mgr.closeSession('sess-1', 1)

      const data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).toBe('final output')
    })

    it('flushes buffered partial escape on close', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      // Send data ending with a partial CSI 3J prefix — gets held in buffer
      await mgr.appendData('sess-1', 'prompt$ \x1b[')
      await mgr.closeSession('sess-1', 0)

      const data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).toBe('prompt$ \x1b[')
    })

    it('ignores close for unknown sessions', async () => {
      // Should not throw
      await mgr.closeSession('nonexistent', 0)
    })
  })

  describe('clear-scrollback detection (CSI 3J)', () => {
    it('resets scrollback.bin when CSI 3J is detected', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      await mgr.appendData('sess-1', 'old output\r\n')
      // CSI 3J = \x1b[3J (erase scrollback)
      await mgr.appendData('sess-1', '\x1b[3J')
      await mgr.appendData('sess-1', 'new output\r\n')

      const data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).not.toContain('old output')
      expect(data).toContain('new output')
    })

    it('handles multiple CSI 3J in one chunk — resets to content after the last', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      await mgr.appendData('sess-1', 'old\x1b[3Jmiddle\x1b[3Jfresh\r\n')

      const data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).not.toContain('old')
      expect(data).not.toContain('middle')
      expect(data).toBe('fresh\r\n')
    })

    it('handles CSI 3J split across chunks', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      await mgr.appendData('sess-1', 'old stuff\r\n')
      await mgr.appendData('sess-1', '\x1b[3')
      await mgr.appendData('sess-1', 'J')
      await mgr.appendData('sess-1', 'fresh\r\n')

      const data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).not.toContain('old stuff')
      expect(data).toContain('fresh')
    })

    it('buffers trailing partial CSI 3J in afterClear content', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      // CSI 3J followed by content that ends with a partial CSI 3J prefix
      await mgr.appendData('sess-1', 'old\x1b[3Jnew-data\x1b[')
      // Complete the sequence — should trigger a second reset
      await mgr.appendData('sess-1', '3Jfinal')

      const data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).not.toContain('old')
      expect(data).not.toContain('new-data')
      expect(data).toBe('final')
    })

    it('resets scrollback on CSI 3J even after 5MB cap is hit', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      const fiveMB = 'x'.repeat(5 * 1024 * 1024)
      await mgr.appendData('sess-1', fiveMB)
      // Cap is hit — normal writes are blocked
      await mgr.appendData('sess-1', 'blocked')
      let data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).not.toContain('blocked')

      // CSI 3J should still reset, allowing new writes
      await mgr.appendData('sess-1', '\x1b[3Jafter-clear')
      data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).toBe('after-clear')
    })
  })

  describe('5MB size cap', () => {
    it('stops appending after 5MB', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      // Write 5MB + some extra
      const chunk = 'x'.repeat(1024 * 1024) // 1MB
      for (let i = 0; i < 6; i++) {
        await mgr.appendData('sess-1', chunk)
      }

      const stats = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'))
      expect(stats.length).toBeLessThanOrEqual(5 * 1024 * 1024 + 1024) // some tolerance
    })
  })

  describe('multiple sessions', () => {
    it('manages independent sessions', async () => {
      await mgr.openSession('a', { cwd: '/a', cols: 80, rows: 24 })
      await mgr.openSession('b', { cwd: '/b', cols: 120, rows: 40 })

      await mgr.appendData('a', 'session-a')
      await mgr.appendData('b', 'session-b')

      const dataA = readFileSync(sessionPath(dir, 'a', 'scrollback.bin'), 'utf-8')
      const dataB = readFileSync(sessionPath(dir, 'b', 'scrollback.bin'), 'utf-8')

      expect(dataA).toBe('session-a')
      expect(dataB).toBe('session-b')
    })
  })

  describe('dispose', () => {
    it('writes endedAt for open sessions to prevent false cold-restore', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.appendData('sess-1', 'data')
      await mgr.dispose()

      const data = readFileSync(sessionPath(dir, 'sess-1', 'scrollback.bin'), 'utf-8')
      expect(data).toBe('data')

      const meta = JSON.parse(readFileSync(sessionPath(dir, 'sess-1', 'meta.json'), 'utf-8'))
      expect(meta.endedAt).not.toBeNull()
      expect(meta.exitCode).toBeNull()
    })

    it('flushes buffered partial escape sequences', async () => {
      await mgr.openSession('partial', { cwd: '/tmp', cols: 80, rows: 24 })
      // Send data ending with a partial CSI 3J prefix
      await mgr.appendData('partial', 'hello\x1b')
      await mgr.dispose()

      const data = readFileSync(sessionPath(dir, 'partial', 'scrollback.bin'), 'utf-8')
      expect(data).toBe('hello\x1b')
    })
  })

  describe('removeSession', () => {
    it('deletes session directory from disk', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.appendData('sess-1', 'data')
      await mgr.closeSession('sess-1', 0)

      await mgr.removeSession('sess-1')
      expect(existsSync(join(dir, getHistorySessionDirName('sess-1')))).toBe(false)
    })
  })

  describe('hasHistory', () => {
    it('returns true for sessions with meta.json on disk', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.closeSession('sess-1', 0)

      expect(mgr.hasHistory('sess-1')).toBe(true)
    })

    it('returns false for unknown sessions', () => {
      expect(mgr.hasHistory('nonexistent')).toBe(false)
    })
  })

  describe('readMeta', () => {
    it('reads meta.json for a session', async () => {
      await mgr.openSession('sess-1', { cwd: '/projects', cols: 100, rows: 30 })
      await mgr.closeSession('sess-1', 42)

      const meta = mgr.readMeta('sess-1')
      expect(meta).not.toBeNull()
      expect(meta!.cwd).toBe('/projects')
      expect(meta!.exitCode).toBe(42)
    })

    it('returns null for missing sessions', () => {
      expect(mgr.readMeta('nonexistent')).toBeNull()
    })
  })

  describe('disk-full handling', () => {
    it('disables writes after fs error and does not throw', async () => {
      await mgr.openSession('disk-full', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.appendData('disk-full', 'before-error')

      // Make scrollback file read-only to trigger write error
      const scrollbackPath = sessionPath(dir, 'disk-full', 'scrollback.bin')
      chmodSync(scrollbackPath, 0o444)

      // Should not throw — error is caught and session is disabled
      await mgr.appendData('disk-full', 'failing-write')

      // Restore permissions so we can read and clean up
      chmodSync(scrollbackPath, 0o644)

      // Subsequent writes were skipped because session was disabled
      const content = readFileSync(scrollbackPath, 'utf-8')
      expect(content).toBe('before-error')
    })

    it('disables writes after fs error on openSession', async () => {
      // Make base dir read-only so mkdirSync fails
      chmodSync(dir, 0o555)

      // Should not throw
      await mgr.openSession('disk-full-open', { cwd: '/tmp', cols: 80, rows: 24 })

      // Restore permissions for cleanup
      chmodSync(dir, 0o755)

      // Session writer was never registered, so appendData is a no-op
      await mgr.appendData('disk-full-open', 'data-after-failed-open')
    })

    it('does not throw on closeSession disk error (prevents false cold-restore)', async () => {
      await mgr.openSession('close-err', { cwd: '/tmp', cols: 80, rows: 24 })

      // Make meta.json read-only so updateMeta's writeFileSync fails
      const metaPath = sessionPath(dir, 'close-err', 'meta.json')
      chmodSync(metaPath, 0o444)

      // Should not throw
      await mgr.closeSession('close-err', 0)

      chmodSync(metaPath, 0o644)
    })

    it('reports write errors via onWriteError callback', async () => {
      const errors: { sessionId: string; error: Error }[] = []
      mgr = new HistoryManager(dir, {
        onWriteError: (sessionId, error) => errors.push({ sessionId, error })
      })

      await mgr.openSession('err-cb', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.appendData('err-cb', 'before')

      const scrollbackPath = sessionPath(dir, 'err-cb', 'scrollback.bin')
      chmodSync(scrollbackPath, 0o444)

      await mgr.appendData('err-cb', 'trigger-error')

      chmodSync(scrollbackPath, 0o644)

      expect(errors).toHaveLength(1)
      expect(errors[0].sessionId).toBe('err-cb')
    })
  })
})
