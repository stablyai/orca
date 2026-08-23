import { describe, expect, it } from 'vitest'
import {
  OXLINT_SCANS,
  diagnosticTouchesAddedLines,
  overlapsAddedLines,
  parseAddedLineRanges
} from './check-changed-code-quality.mjs'

describe('changed-code quality line matching', () => {
  it('parses added and replaced hunk ranges while ignoring deletions', () => {
    const ranges = parseAddedLineRanges(
      ['@@ -10,2 +10,3 @@', '@@ -20 +21 @@', '@@ -40,4 +42,0 @@', '@@ -50 +48,2 @@'].join('\n')
    )

    expect(ranges).toEqual([
      { start: 10, end: 12 },
      { start: 21, end: 21 },
      { start: 48, end: 49 }
    ])
  })

  it('matches diagnostics that overlap any added line', () => {
    const ranges = [
      { start: 5, end: 7 },
      { start: 12, end: 12 }
    ]

    expect(overlapsAddedLines(3, 5, ranges)).toBe(true)
    expect(overlapsAddedLines(8, 11, ranges)).toBe(false)
    expect(overlapsAddedLines(12, 14, ranges)).toBe(true)
  })

  it('normalizes absolute diagnostic paths before matching', () => {
    const root = process.cwd()
    const file = 'config/scripts/check-changed-code-quality.test.mjs'
    const diagnostic = {
      filename: `${root}/${file}`,
      labels: [{ span: { line: 24 } }]
    }

    expect(
      diagnosticTouchesAddedLines(diagnostic, new Map([[file, [{ start: 24, end: 24 }]]]), root)
    ).toBe(true)
  })

  // Why: pinning --config disables nested-config discovery, so root rules that
  // mobile/.oxlintrc.json turns off would fail the gate on mobile files.
  it('lets the untyped scan discover nested configs instead of pinning the root config', () => {
    const scan = OXLINT_SCANS.find((candidate) => candidate.label === 'code quality')

    expect(scan.args).not.toContain('--config')
    expect(scan.args).not.toContain('--disable-nested-config')
  })

  // Why: the type-aware scan DOES pin the root config, and mobile's types resolve only from
  // mobile/node_modules. Linting mobile under the root config makes every such import an `error`
  // type, which no-redundant-type-constituents reports as a real finding — findings the package
  // script cannot reproduce, because it scopes this scan to `src config tests`.
  it('keeps the type-aware scan off mobile, whose types the root config cannot resolve', () => {
    const scan = OXLINT_SCANS.find((candidate) => candidate.label === 'type-aware code quality')

    expect(scan.args).toContain('--type-aware')
    expect(scan.excludes('mobile/src/session/use-mobile-structured-attachments.test.ts')).toBe(true)
    expect(scan.excludes('mobile')).toBe(true)
    expect(scan.excludes('src/main/runtime/orca-runtime.ts')).toBe(false)
    // A path that merely starts with the same letters is not inside the package.
    expect(scan.excludes('mobile-shim/src/a.ts')).toBe(false)
  })
})
