import { describe, expect, it, vi } from 'vitest'
import type { TerminalSnapshot } from './types'
import { serializeTerminalCheckpointWithinLimit } from './terminal-checkpoint-serializer'

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
  it('matches JSON.stringify exactly at the UTF-8 byte limit', async () => {
    const input = snapshot({
      snapshotAnsi: `é漢😀${String.fromCharCode(0xd800, 0xdc00)}"\\${String.fromCharCode(
        0x00,
        0x08,
        0x09,
        0x0a,
        0x0c,
        0x0d,
        0x1f,
        0xd800,
        0xdc00
      )}`,
      oscLinks: [{ row: 0, startCol: 0, endCol: 1, uri: 'https://example.com/😀\n' }]
    })
    const expected = JSON.stringify({
      snapshotAnsi: input.snapshotAnsi,
      scrollbackAnsi: input.scrollbackAnsi,
      oscLinks: input.oscLinks,
      rehydrateSequences: input.rehydrateSequences,
      cwd: metadata.cwd,
      cols: input.cols,
      rows: input.rows,
      modes: input.modes,
      scrollbackLines: input.scrollbackLines,
      generation: metadata.generation,
      checkpointedAt: metadata.checkpointedAt
    })
    const exactBytes = Buffer.byteLength(expected, 'utf8')

    await expect(serializeTerminalCheckpointWithinLimit(input, metadata, exactBytes)).resolves.toBe(
      expected
    )
  })

  it('rejects multibyte input whose code-unit length fits under the byte cap', async () => {
    const input = snapshot({
      scrollbackAnsi: 'é\r\n'.repeat(100),
      scrollbackLines: 100
    })
    const expected = JSON.stringify({
      snapshotAnsi: input.snapshotAnsi,
      scrollbackAnsi: input.scrollbackAnsi,
      oscLinks: input.oscLinks,
      rehydrateSequences: input.rehydrateSequences,
      cwd: metadata.cwd,
      cols: input.cols,
      rows: input.rows,
      modes: input.modes,
      scrollbackLines: input.scrollbackLines,
      generation: metadata.generation,
      checkpointedAt: metadata.checkpointedAt
    })
    const maxBytes = expected.length + 1

    expect(expected.length).toBeLessThan(maxBytes)
    expect(Buffer.byteLength(expected, 'utf8')).toBeGreaterThan(maxBytes)

    const serialized = await serializeTerminalCheckpointWithinLimit(input, metadata, maxBytes)

    expect(serialized).not.toBe(expected)
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(maxBytes)
  })

  it('keeps native conversion bounded without materializing the whole candidate', async () => {
    let reads = 0
    const input = snapshot()
    Object.defineProperty(input, 'snapshotAnsi', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'visible'.repeat(20_000)
      }
    })
    const stringify = vi.spyOn(JSON, 'stringify')
    const byteLength = vi.spyOn(Buffer, 'byteLength')

    try {
      await serializeTerminalCheckpointWithinLimit(input, metadata, 200 * 1024)

      expect(
        stringify.mock.calls.some(([value]) => typeof value === 'object' && value !== null)
      ).toBe(false)
      for (const [value] of stringify.mock.calls) {
        if (typeof value === 'string') {
          expect(value.length).toBeLessThanOrEqual(64 * 1024)
        }
      }
      for (const [value] of byteLength.mock.calls) {
        if (typeof value === 'string') {
          expect(value.length).toBeLessThanOrEqual(128 * 1024)
        }
      }
      expect(reads).toBe(1)
    } finally {
      stringify.mockRestore()
      byteLength.mockRestore()
    }
  })

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

  it('rejects an oversized escaped candidate without materializing it', async () => {
    const oversized = String.fromCharCode(0).repeat(100_000)
    const stringify = vi.spyOn(JSON, 'stringify')

    try {
      await serializeTerminalCheckpointWithinLimit(
        snapshot({ snapshotAnsi: oversized }),
        metadata,
        512
      )

      const materializedOversizedCandidate = stringify.mock.calls.some(([value]) => {
        return (value as { snapshotAnsi?: unknown })?.snapshotAnsi === oversized
      })
      expect(materializedOversizedCandidate).toBe(false)
    } finally {
      stringify.mockRestore()
    }
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

  it('rejects huge escaped metadata using bounded native conversions near the byte cap', async () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    const byteLength = vi.spyOn(Buffer, 'byteLength')
    try {
      await expect(
        serializeTerminalCheckpointWithinLimit(
          snapshot(),
          { ...metadata, cwd: String.fromCharCode(0).repeat(1_000_000) },
          512
        )
      ).rejects.toThrow('Terminal checkpoint metadata exceeds byte limit')
      for (const [value] of stringify.mock.calls) {
        expect(typeof value === 'object' && value !== null).toBe(false)
        if (typeof value === 'string') {
          expect(value.length).toBeLessThanOrEqual(512)
        }
      }
      for (const [value] of byteLength.mock.calls) {
        if (typeof value === 'string') {
          expect(value.length).toBeLessThanOrEqual(512 * 6)
        }
      }
    } finally {
      stringify.mockRestore()
      byteLength.mockRestore()
    }
  })
})
