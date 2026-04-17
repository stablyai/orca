import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

describe('HeadlessEmulator', () => {
  let emulator: HeadlessEmulator

  afterEach(() => {
    emulator?.dispose()
  })

  describe('construction', () => {
    it('creates with specified dimensions', () => {
      emulator = new HeadlessEmulator({ cols: 120, rows: 40 })
      const snapshot = emulator.getSnapshot()
      expect(snapshot.cols).toBe(120)
      expect(snapshot.rows).toBe(40)
    })

    it('defaults cwd to null', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().cwd).toBeNull()
    })
  })

  describe('write and snapshot', () => {
    it('captures written text in snapshot', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('hello world')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.snapshotAnsi).toContain('hello world')
    })

    it('captures colored text', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[31mred text\x1b[0m')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.snapshotAnsi).toContain('red text')
    })
  })

  describe('OSC-7 CWD tracking', () => {
    it('parses OSC-7 file URI to extract CWD', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file://localhost/Users/test/project\x07')

      expect(emulator.getSnapshot().cwd).toBe('/Users/test/project')
    })

    it('handles OSC-7 with empty host', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///home/user/work\x07')

      expect(emulator.getSnapshot().cwd).toBe('/home/user/work')
    })

    it('updates CWD when new OSC-7 arrives', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///first\x07')
      expect(emulator.getSnapshot().cwd).toBe('/first')

      await emulator.write('\x1b]7;file:///second\x07')
      expect(emulator.getSnapshot().cwd).toBe('/second')
    })

    it('decodes percent-encoded paths', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///Users/test/my%20project\x07')

      expect(emulator.getSnapshot().cwd).toBe('/Users/test/my project')
    })

    it('normalizes Windows drive-letter OSC-7 paths', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })

      try {
        await emulator.write('\x1b]7;file:///C:/Users/test/project\x07')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      expect(emulator.getSnapshot().cwd).toBe('C:/Users/test/project')
    })

    it('preserves Windows UNC OSC-7 paths', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })

      try {
        await emulator.write('\x1b]7;file://server/share/project\x07')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      expect(emulator.getSnapshot().cwd).toBe('\\\\server\\share\\project')
    })

    it('handles OSC-7 with ST terminator', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///path/here\x1b\\')

      expect(emulator.getSnapshot().cwd).toBe('/path/here')
    })
  })

  describe('resize', () => {
    it('updates dimensions', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      emulator.resize(120, 40)

      const snapshot = emulator.getSnapshot()
      expect(snapshot.cols).toBe(120)
      expect(snapshot.rows).toBe(40)
    })
  })

  describe('clear scrollback (CSI 3J)', () => {
    it('detects CSI 3J and clears scrollback', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      // Write enough lines to push into scrollback
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join('')
      await emulator.write(lines)

      const before = emulator.getSnapshot()
      expect(before.scrollbackLines).toBeGreaterThan(0)

      await emulator.write('\x1b[3J')
      const after = emulator.getSnapshot()
      expect(after.scrollbackLines).toBe(0)
    })
  })

  describe('onData callback', () => {
    it('fires onData for terminal query responses', async () => {
      const responses: string[] = []
      emulator = new HeadlessEmulator({
        cols: 80,
        rows: 24,
        onData: (data) => responses.push(data)
      })

      // DA1 query — xterm.js will respond with a device attributes string
      await emulator.write('\x1b[c')

      expect(responses.length).toBeGreaterThan(0)
    })
  })

  describe('terminal modes', () => {
    it('tracks bracketed paste mode', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().modes.bracketedPaste).toBe(false)

      await emulator.write('\x1b[?2004h')
      expect(emulator.getSnapshot().modes.bracketedPaste).toBe(true)

      await emulator.write('\x1b[?2004l')
      expect(emulator.getSnapshot().modes.bracketedPaste).toBe(false)
    })

    it('tracks alternate screen mode', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().modes.alternateScreen).toBe(false)

      await emulator.write('\x1b[?1049h')
      expect(emulator.getSnapshot().modes.alternateScreen).toBe(true)

      await emulator.write('\x1b[?1049l')
      expect(emulator.getSnapshot().modes.alternateScreen).toBe(false)
    })
  })

  describe('rehydration sequences', () => {
    it('generates rehydration for non-default modes', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[?2004h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.rehydrateSequences).toContain('\x1b[?2004h')
    })

    it('generates empty rehydration when all modes are default', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('just plain text')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.rehydrateSequences).toBe('')
    })
  })

  describe('dispose', () => {
    it('can be disposed without error', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(() => emulator.dispose()).not.toThrow()
    })
  })
})
