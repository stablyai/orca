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

/** Mirrors the on-disk field order the serializer emits, so tests can compare against
 *  real JSON.stringify output rather than a hand-written string. */
function expectedJson(input: TerminalSnapshot): string {
  return JSON.stringify({
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
    const expected = expectedJson(input)
    const exactBytes = Buffer.byteLength(expected, 'utf8')

    await expect(serializeTerminalCheckpointWithinLimit(input, metadata, exactBytes)).resolves.toBe(
      expected
    )
  })

  it('sizes lone surrogates as JSON.stringify escapes them', async () => {
    // Why: an unpaired surrogate costs 6 bytes as \\udXXX, not the 3 a BMP char would.
    const input = snapshot({
      snapshotAnsi: `${String.fromCharCode(0xd800)}lone${String.fromCharCode(0xdfff)}`
    })
    const expected = expectedJson(input)

    await expect(
      serializeTerminalCheckpointWithinLimit(input, metadata, Buffer.byteLength(expected, 'utf8'))
    ).resolves.toBe(expected)
  })

  it('rejects multibyte input whose code-unit length fits under the byte cap', async () => {
    const input = snapshot({
      scrollbackAnsi: 'é\r\n'.repeat(100),
      scrollbackLines: 100
    })
    const expected = expectedJson(input)
    const maxBytes = expected.length + 1

    expect(expected.length).toBeLessThan(maxBytes)
    expect(Buffer.byteLength(expected, 'utf8')).toBeGreaterThan(maxBytes)

    const serialized = await serializeTerminalCheckpointWithinLimit(input, metadata, maxBytes)

    expect(serialized).not.toBe(expected)
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(maxBytes)
  })

  it('reads each snapshot field once on the passing path', async () => {
    let reads = 0
    const input = snapshot()
    Object.defineProperty(input, 'snapshotAnsi', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'visible'
      }
    })

    await serializeTerminalCheckpointWithinLimit(input, metadata, 20 * 1024)

    expect(reads).toBe(1)
  })

  it('rejects a candidate whose escapes push it over the cap by a single byte', async () => {
    // Why: the sizing walk is the only thing standing between an over-cap payload and disk,
    // so pin the boundary in both directions rather than trusting a coarse limit.
    const ansi = `${String.fromCharCode(0x1b)}[0m漢😀"\\\n`
    const input = snapshot({ snapshotAnsi: ansi.repeat(64) })
    const expected = expectedJson(input)
    const exactBytes = Buffer.byteLength(expected, 'utf8')

    await expect(serializeTerminalCheckpointWithinLimit(input, metadata, exactBytes)).resolves.toBe(
      expected
    )

    const trimmed = await serializeTerminalCheckpointWithinLimit(input, metadata, exactBytes - 1)

    expect(trimmed).not.toBe(expected)
    expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(exactBytes - 1)
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
})
