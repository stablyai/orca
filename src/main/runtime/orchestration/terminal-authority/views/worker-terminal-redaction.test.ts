import { describe, expect, it } from 'vitest'
import { redactWorkerTerminalLines, redactWorkerTerminalView } from './worker-terminal-redaction'

describe('worker terminal capability masking', () => {
  it('does not infer wrapping between independent completed stream lines', () => {
    const lines = [`dcap_${'s'.repeat(5)}`, 's'.repeat(19)]
    expect(redactWorkerTerminalLines(lines)).toEqual({ lines, warnings: [] })
  })

  it.each([
    [`dcap_${'s'.repeat(5)}`, 's'.repeat(19)],
    ['d', 'c', 'a', 'p', '_', ...Array(24).fill('s')],
    ['dc', `ap_${'s'.repeat(7)}`, 's'.repeat(17)]
  ])(
    'masks recoverable fragments while preserving rows and following diagnostics (%j)',
    (...rows: string[]) => {
      const lines = [...rows, 'OK', 'Safe diagnostic']
      const result = redactWorkerTerminalLines(
        lines,
        lines.map((_line, index) => ({
          wrapped: index > 0 && index < rows.length,
          trailingSpaces: 0
        }))
      )
      expect(result.lines).toHaveLength(lines.length)
      expect(result.lines.join('')).not.toContain(`dcap_${'s'.repeat(24)}`)
      expect(result.lines).toContain('[dispatch capability redacted]')
      expect(result.lines.slice(-2)).toEqual(['OK', 'Safe diagnostic'])
      expect(result.warnings).toHaveLength(1)
    }
  )

  it.each(['\n', '\r\n'])('preserves hard multiline draft breaks (%j)', (separator) => {
    const draft = ['dc', 'ap_sssss', 's'.repeat(19), 'OK'].join(separator)
    const result = redactWorkerTerminalView({ tail: ['Safe diagnostic'], source: 'stream', draft })
    expect(result.draft).toBe(draft)
    expect(result.draft?.split(separator)).toHaveLength(4)
    expect(result.draft?.endsWith(`${separator}OK`)).toBe(true)
    expect(result.tail).toEqual(['Safe diagnostic'])
    expect(result.warnings).toHaveLength(0)
  })

  it('does not join a terminal tail and composer draft for token discovery', () => {
    const tail = [`dcap_${'s'.repeat(5)}`]
    const draft = 's'.repeat(19)
    expect(redactWorkerTerminalView({ tail, draft, source: 'stream' })).toEqual({
      tail,
      draft,
      warnings: []
    })
  })

  it('maps multiple complete values back to their physical rows', () => {
    const secret = 'dcap_abcdefghijklmnopqrstuvwx'
    const lines = [
      `before ${secret} middle dc`,
      'ap_abcdefghijklmnopqrstuvwx after',
      'PermissionDenied'
    ]
    expect(
      redactWorkerTerminalLines(lines, [
        { wrapped: false, trailingSpaces: 0 },
        { wrapped: true, trailingSpaces: 0 },
        { wrapped: false, trailingSpaces: 0 }
      ]).lines
    ).toEqual([
      'before [dispatch capability redacted] middle [dispatch capability redacted]',
      ' after',
      'PermissionDenied'
    ])
  })

  it('removes the full suffix of a complete value spanning the retained row bound', () => {
    const lines = ['dcap_', ...Array.from({ length: 1998 }, () => 's'), 'PermissionDenied']
    const rows = lines.map((_line, index) => ({
      wrapped: index > 0 && index < 1999,
      trailingSpaces: 0
    }))
    const result = redactWorkerTerminalLines(lines, rows)
    expect(result.lines).toEqual([
      '[dispatch capability redacted]',
      ...Array.from({ length: 1998 }, () => ''),
      'PermissionDenied'
    ])
  })

  it.each([-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'falls back to complete lines for invalid padding (%s)',
    (trailingSpaces) => {
      const tail = ['dcap_sssss', 'PermissionDenied', 'dcap_abcdefghijklmnopqrstuvwx']
      const result = redactWorkerTerminalView({
        tail,
        source: 'screen',
        tailRows: tail.map((_line, index) => ({ wrapped: index > 0, trailingSpaces }))
      })
      expect(result.tail).toEqual([
        'dcap_sssss',
        'PermissionDenied',
        '[dispatch capability redacted]'
      ])
      expect(result.warnings).toContain(
        'Terminal wrap information was unavailable; capability masking used complete lines.'
      )
    }
  )
})
