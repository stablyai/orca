import { describe, expect, it } from 'vitest'
import { TerminalMouseModeMirror } from './terminal-mouse-mode-mirror'

function heapAfterGc(): number {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  // Isolate mirror ownership from V8's process-wide last successful regexp input.
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

describe('mouse mode scan tail retention', () => {
  it.each(['\x1b[', '\x9b'])(
    'retains a split %j mode sequence without retaining consumed output',
    (introducer) => {
      const before = heapAfterGc()
      const mirrors = Array.from({ length: 8 }, (_value, index) => {
        const mirror = new TerminalMouseModeMirror()
        mirror.scan(`${index}:${'x'.repeat(4 * 1024 * 1024)}${introducer}?1049;2004;1000;`)
        return mirror
      })

      expect(heapAfterGc() - before).toBeLessThan(2 * 1024 * 1024)
      for (const mirror of mirrors) {
        expect(mirror.mouseTrackingMode).toBe('none')
        mirror.scan('1006h')
        expect(mirror.mouseTrackingMode).toBe('vt200')
        expect(mirror.sgrMouseMode).toBe(true)
        mirror.scan('\x1b[?1016h')
        expect(mirror.sgrMouseMode).toBe(false)
        expect(mirror.sgrMousePixelsMode).toBe(true)
        mirror.scan('\x1bc')
        expect(mirror.mouseTrackingMode).toBe('none')
        expect(mirror.sgrMousePixelsMode).toBe(false)
      }
    }
  )
})
