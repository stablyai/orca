import { describe, expect, it } from 'vitest'
import { parseKiroUsageOutput, stripAnsi } from './kiro-usage-parser'

// Captured verbatim from `kiro-cli chat --no-interactive "/usage"`, including the
// ANSI styling and block-meter glyphs the CLI emits.
const REAL_OUTPUT =
  'One or more mcp server did not load correctly.\n------\n\n' +
  '\u001B[1mEstimated Usage\u001B[0m | resets on 2026-10-01 | \u001B[38;5;141mKIRO PRO\u001B[0m\n' +
  '\u001B[1mCredits\u001B[0m (132.35 of 1000 covered in plan)\n' +
  '\u001B[38;5;141m██████████\u001B[38;5;244m█████████████████████\u001B[0m 13.2%\n\n' +
  'Since your account is through your organization, for account management please contact your account administrator.\n' +
  '\u001B[1G\u001B[0m\u001B[0m\u001B[?25h\n'

describe('stripAnsi', () => {
  it('removes CSI/OSC escapes and carriage returns', () => {
    expect(stripAnsi('\u001B[1mBold\u001B[0m\r\ntext')).toBe('Bold\ntext')
  })
})

describe('parseKiroUsageOutput', () => {
  it('parses the real /usage meter', () => {
    const quota = parseKiroUsageOutput(REAL_OUTPUT)
    expect(quota).not.toBeNull()
    expect(quota?.used).toBe(132.35)
    expect(quota?.limit).toBe(1000)
    expect(quota?.usedPercent).toBe(13.2)
    expect(quota?.resetsOn).toBe('2026-10-01')
    expect(quota?.plan).toBe('KIRO PRO')
  })

  it('falls back to computed percent when the CLI omits the % line', () => {
    const quota = parseKiroUsageOutput('Credits (250 of 1000 covered in plan)')
    expect(quota?.usedPercent).toBe(25)
    expect(quota?.resetsOn).toBeNull()
    expect(quota?.plan).toBeNull()
  })

  it('returns null when no plan line is present', () => {
    expect(parseKiroUsageOutput('Something else entirely')).toBeNull()
    expect(parseKiroUsageOutput('')).toBeNull()
  })

  it('rejects a zero or invalid limit', () => {
    expect(parseKiroUsageOutput('Credits (5 of 0 covered in plan)')).toBeNull()
  })
})
