import { describe, expect, it } from 'vitest'
import {
  OXLINT_SCANS,
  assertSupportedNodeEngine,
  diagnosticTouchesAddedLines,
  expectedNodeMajor,
  isMovedCode,
  main,
  isRootCodeQualityPath,
  overlapsAddedLines,
  parseAddedLineRanges,
  parseOxlintOutput,
  runOxlintScan
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

  it('leaves Cloud source to the independent Cloud quality checks', () => {
    expect(isRootCodeQualityPath('cloud/apps/relay/src/index.ts')).toBe(false)
    expect(isRootCodeQualityPath('src/main/index.ts')).toBe(true)
  })
})

describe('changed-code quality execution safety', () => {
  it('extracts the Oxlint report after a JSON-shaped pnpm engine warning', () => {
    const warning =
      'WARN Unsupported engine: wanted: {"node":"24"} (current: {"node":"22.23.2","pnpm":"10.24.0"})'
    const report = { diagnostics: [], number_of_files: 1, number_of_rules: 167 }

    expect(parseOxlintOutput(`${warning}\n${JSON.stringify(report)}`, 'code quality')).toEqual(
      report
    )
  })

  it('rejects malformed or missing Oxlint reports with bounded diagnostics', () => {
    expect(() => parseOxlintOutput('{"diagnostics":[}', 'code quality')).toThrow(
      /one validated Oxlint JSON report/
    )
    const hugeStderr = 'engine warning '.repeat(1000)
    expect(() =>
      runOxlintScan(
        process.cwd(),
        OXLINT_SCANS[0],
        ['config/scripts/check-changed-code-quality.mjs'],
        () => ({ status: 1, stdout: '', stderr: hugeStderr })
      )
    ).toThrow(/code quality output stage failed/)
  })

  it('preserves diagnostics through the resolved Oxlint invocation', () => {
    const file = 'config/scripts/check-changed-code-quality.test.mjs'
    const diagnostic = {
      filename: file,
      message: 'A real changed-line finding',
      code: 'no-debugger',
      labels: [{ span: { line: 24 } }]
    }
    let invokedCommand
    const diagnostics = runOxlintScan(process.cwd(), OXLINT_SCANS[0], [file], (command) => {
      invokedCommand = command
      return { status: 1, stdout: JSON.stringify({ diagnostics: [diagnostic] }), stderr: '' }
    })

    expect(invokedCommand).toBe(process.execPath)
    expect(diagnostics).toEqual([diagnostic])
  })

  it('fails before scanning on an unsupported Node engine', () => {
    expect(expectedNodeMajor(process.cwd())).toBe(24)
    expect(assertSupportedNodeEngine(process.cwd(), '24.7.0')).toEqual({
      expectedMajor: 24,
      observedMajor: 24,
      observedVersion: '24.7.0'
    })
    const error = console.error
    const messages = []
    console.error = (...args) => messages.push(args.join(' '))
    try {
      expect(main(process.cwd(), undefined, { nodeVersion: '22.23.2' })).toBe(1)
    } finally {
      console.error = error
    }
    expect(messages.join('\n')).toMatch(
      /Node engine preflight failed: expected Node 24, observed 22\.23\.2\./
    )
  })
})

describe('moved-code exemption', () => {
  it('treats a verbatim contiguous block from the base as moved', () => {
    const base = [['const a = 1', 'items.map((item, index) => (', 'key={index}', '))']]
    expect(isMovedCode(['items.map((item, index) => (', 'key={index}', '))'], base)).toBe(true)
  })

  it('ignores indentation and whitespace changes from the move', () => {
    const base = [['    items.map((item, index) => (', '      key={index}']]
    expect(isMovedCode(['items.map((item, index) => (', 'key={index}'], base)).toBe(true)
  })

  it('does not exempt a genuinely new violation', () => {
    const base = [['const a = 1', 'const b = 2']]
    expect(isMovedCode(['rows.map((row, i) => <td key={i} />)'], base)).toBe(false)
  })

  it('does not exempt a block that is only partly present in the base', () => {
    const base = [['doThing()', 'unrelated()']]
    expect(isMovedCode(['doThing()', 'newlyAddedSideEffect()'], base)).toBe(false)
  })

  it('tolerates a few lines appended inside the moved block', () => {
    // A split commonly grows a hook dependency array when closure variables
    // become props; the moved body around it is still moved.
    const body = Array.from({ length: 20 }, (_, i) => `line${i}()`)
    const base = [body]
    const moved = [...body.slice(0, 19), 'newDep,', body[19]]
    expect(isMovedCode(moved, base)).toBe(true)
  })

  it('does not exempt when the anchor line is absent from the base', () => {
    const base = [['doThing()', 'filler()', 'other()']]
    expect(isMovedCode(['brandNewCall()', 'doThing()', 'other()'], base)).toBe(false)
  })

  it('does not exempt when most of the block is absent from the base', () => {
    const base = [['keep0()', 'keep1()', 'unrelated()']]
    const mostlyNew = ['keep0()', ...Array.from({ length: 18 }, (_, i) => `fresh${i}()`)]
    expect(isMovedCode(mostlyNew, base)).toBe(false)
  })

  it('ignores blank lines when matching', () => {
    const base = [['a()', 'b()']]
    expect(isMovedCode(['a()', '', 'b()'], base)).toBe(true)
  })

  it('never exempts an empty highlight', () => {
    expect(isMovedCode(['', '   '], [['a()']])).toBe(false)
  })
})
