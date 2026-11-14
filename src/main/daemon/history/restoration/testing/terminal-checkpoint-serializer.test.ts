import { describe, expect, it } from 'vitest'
import type { TerminalSnapshot } from '../../../protocol/terminal-snapshot'
import { serializeTerminalCheckpointWithinLimit } from '../terminal-checkpoint-serializer'

function snapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    snapshotAnsi: 'visible',
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
    scrollbackLines: 0,
    ...overrides
  }
}

const metadata = {
  cwd: '/workspace',
  generation: 1,
  checkpointedAt: '2026-07-29T00:00:00.000Z'
}

describe('terminal checkpoint serializer', () => {
  it('preserves shell ownership when an oversized alternate-screen checkpoint is trimmed', async () => {
    const input = snapshot({
      snapshotAnsi: `\x1b[?1049h${'row\r\n'.repeat(500)}visible`,
      rehydrateSequences: '\x1b[?1049h',
      terminalOwner: 'shell',
      modes: {
        bracketedPaste: false,
        mouseTracking: false,
        applicationCursor: false,
        alternateScreen: true
      },
      scrollbackLines: 500
    })

    const serialized = await serializeTerminalCheckpointWithinLimit(input, metadata, 2_048)

    expect(JSON.parse(serialized)).toMatchObject({ terminalOwner: 'shell' })
  })

  it('keeps kitty keyboard flags when an oversized checkpoint is trimmed', async () => {
    const input = snapshot({
      scrollbackAnsi: 'row\r\n'.repeat(500),
      modes: { ...snapshot().modes, kittyKeyboardFlags: 1 },
      scrollbackLines: 500
    })

    const serialized = await serializeTerminalCheckpointWithinLimit(input, metadata, 2_048)

    expect(JSON.parse(serialized).modes.kittyKeyboardFlags).toBe(1)
  })
  it.each([16 * 1024 - 1, 16 * 1024])(
    'preserves hardcoded control and surrogate JSON after %i code units',
    async (prefixLength) => {
      const prefix = 'x'.repeat(prefixLength)
      const input = snapshot({
        snapshotAnsi: `${prefix}😀\ud800x\udc00"\b\t\n\f\r\\\0`
      })
      const expectedPrefix =
        `{"snapshotAnsi":"${prefix}😀\\ud800x\\udc00\\"\\b\\t\\n\\f\\r\\\\\\u0000",` +
        '"scrollbackAnsi":""'
      const serialized = await serializeTerminalCheckpointWithinLimit(input, metadata, 40 * 1024)
      expect(serialized.startsWith(expectedPrefix)).toBe(true)
      expect(JSON.parse(serialized).snapshotAnsi).toBe(input.snapshotAnsi)
      const exactBytes = Buffer.byteLength(serialized, 'utf8')
      await expect(
        serializeTerminalCheckpointWithinLimit(input, metadata, exactBytes)
      ).resolves.toBe(serialized)
      const trimmed = await serializeTerminalCheckpointWithinLimit(input, metadata, exactBytes - 1)
      expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThan(exactBytes)
    }
  )
})
