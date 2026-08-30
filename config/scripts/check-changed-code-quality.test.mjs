import { describe, expect, it } from 'vitest'
import {
  OXLINT_SCANS,
  batchFilesByArgumentBytes,
  diagnosticTouchesAddedLines,
  environmentEntries,
  isMovedCode,
  maxBatchArgumentBytes,
  overlapsAddedLines,
  parseAddedLineRanges,
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

describe('argument batching', () => {
  // Mirrors the script's own accounting: every argv/envp entry costs a pointer beside its bytes.
  const spawnBytes = (entries) =>
    entries.reduce((total, entry) => total + Buffer.byteLength(entry, 'utf8') + 12, 0)
  // Large enough to exceed the real byte budget, so the batching that ships is what runs.
  const oversizedSet = Array.from(
    { length: 20000 },
    (_, index) => `src/generated/module-${index}.ts`
  )
  const fixedArguments = [
    '/usr/local/bin/node',
    '/repo/node_modules/oxlint/bin/oxlint',
    '--format',
    'json'
  ]
  // Big enough that the budget must shrink below the cap, small enough to still batch.
  const largeEnvironment = { PATH: '/usr/bin', ORCA_LARGE_VARIABLE: 'x'.repeat(300 * 1024) }
  const fatEnvironment = { PATH: '/usr/bin', ORCA_FAT_VARIABLE: 'x'.repeat(900 * 1024) }
  // Half of macOS kern.argmax: spawning Node fails from stack pressure near 970 KiB, well
  // before the kernel's own 1 MiB E2BIG.
  const POSIX_CEILING = 512 * 1024
  // CreateProcess' documented lpCommandLine maximum.
  const WINDOWS_CEILING = 32767

  it('runs a normal changed set as a single invocation', () => {
    const files = Array.from({ length: 50 }, (_, index) => `src/renderer/src/module-${index}.tsx`)

    expect(batchFilesByArgumentBytes(files)).toEqual([files])
  })

  it('uses a Windows-safe budget without shrinking Unix batches', () => {
    expect(maxBatchArgumentBytes({ platform: 'win32', env: {} })).toBe(32767 - 8 * 1024)
    expect(maxBatchArgumentBytes({ platform: 'linux', env: {} })).toBe(256 * 1024)
    expect(maxBatchArgumentBytes({ platform: 'darwin', env: {} })).toBe(256 * 1024)
  })

  it('splits an oversized set into batches that each fit the limit', () => {
    const batches = batchFilesByArgumentBytes(oversizedSet)

    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(oversizedSet)
    for (const batch of batches) {
      expect(spawnBytes(batch)).toBeLessThanOrEqual(256 * 1024)
    }
  })

  // Why: an empty argument list makes Oxlint lint the whole working directory.
  it('never emits an empty batch, even when the first path is longer than the limit', () => {
    const batches = batchFilesByArgumentBytes(['src/very-long-path.ts', 'src/a.ts'], 10)

    expect(batches.every((batch) => batch.length > 0)).toBe(true)
    expect(batches.flat()).toEqual(['src/very-long-path.ts', 'src/a.ts'])
  })

  it('counts multi-byte paths by their byte length, not their character count', () => {
    expect(batchFilesByArgumentBytes(['src/\u00e9.ts', 'src/b.ts'], 30)).toEqual([
      ['src/\u00e9.ts'],
      ['src/b.ts']
    ])
  })

  // Why: execve() charges argv and the inherited environment against one ceiling, so a
  // budget computed from the file list alone stacks 256 KiB of paths on top of whatever the
  // shell already carries, and the spawn fails before Oxlint ever starts.
  it('keeps the whole POSIX spawn — arguments and environment — under the ceiling', () => {
    const limit = maxBatchArgumentBytes({
      platform: 'darwin',
      fixedArguments,
      env: largeEnvironment
    })
    const batches = batchFilesByArgumentBytes(oversizedSet, limit)
    const environmentCost = spawnBytes(environmentEntries(largeEnvironment))

    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) {
      expect(spawnBytes([...fixedArguments, ...batch]) + environmentCost).toBeLessThanOrEqual(
        POSIX_CEILING
      )
    }
  })

  it('shrinks the POSIX budget as the environment grows', () => {
    const small = maxBatchArgumentBytes({ platform: 'darwin', fixedArguments, env: { A: 'a' } })
    const large = maxBatchArgumentBytes({
      platform: 'darwin',
      fixedArguments,
      env: largeEnvironment
    })

    expect(large).toBeLessThan(small)
  })

  // Why: CreateProcess caps the command line only; the environment ships in its own block.
  it('budgets Windows from the command line alone and stays inside CreateProcess', () => {
    const limit = maxBatchArgumentBytes({
      platform: 'win32',
      fixedArguments,
      env: fatEnvironment
    })

    expect(limit).toBe(maxBatchArgumentBytes({ platform: 'win32', fixedArguments, env: {} }))
    for (const batch of batchFilesByArgumentBytes(oversizedSet, limit)) {
      expect(spawnBytes([...fixedArguments, ...batch])).toBeLessThanOrEqual(WINDOWS_CEILING)
    }
  })

  // Why: a zero budget would spawn Oxlint once per path instead of failing usefully.
  it('floors the budget when the environment alone exceeds the ceiling', () => {
    const limit = maxBatchArgumentBytes({
      platform: 'darwin',
      fixedArguments,
      env: { ORCA_FAT_VARIABLE: 'x'.repeat(4 * 1024 * 1024) }
    })

    expect(limit).toBe(8 * 1024)
  })

  it('ignores environment entries that carry no value', () => {
    expect(environmentEntries({ A: 'a', B: undefined })).toEqual(['A=a'])
  })
})

describe('diagnostic collection across batches', () => {
  const scan = { label: 'code quality', args: [] }
  const diagnosticFor = (file) => ({ filename: file, message: `finding in ${file}` })
  const files = Array.from({ length: 20000 }, (_, index) => `src/generated/module-${index}.ts`)
  const observeBatches = () => {
    const batches = []
    runOxlintScan('/repo', scan, files, (_root, _scan, batch) => {
      batches.push(batch)
      return JSON.stringify({ diagnostics: [] })
    })
    return batches
  }
  const reportOnly = (failing) => (_root, _scan, batch) =>
    JSON.stringify({ diagnostics: batch.includes(failing) ? [diagnosticFor(failing)] : [] })

  it('keeps the diagnostics of every batch, not just the last one', () => {
    const spawnBatch = (_root, _scan, batch) =>
      JSON.stringify({ diagnostics: batch.map(diagnosticFor) })

    expect(observeBatches().length).toBeGreaterThan(1)
    expect(runOxlintScan('/repo', scan, files, spawnBatch)).toEqual(files.map(diagnosticFor))
  })

  it('reports a finding that only a middle batch produces', () => {
    const batches = observeBatches()
    expect(batches.length).toBeGreaterThan(2)
    const failing = batches.at(Math.floor(batches.length / 2)).at(0)

    expect(batches.at(0)).not.toContain(failing)
    expect(batches.at(-1)).not.toContain(failing)
    expect(runOxlintScan('/repo', scan, files, reportOnly(failing))).toEqual([
      diagnosticFor(failing)
    ])
  })

  it('reports a finding that only the last batch produces', () => {
    const batches = observeBatches()
    const failing = batches.at(-1).at(-1)

    expect(batches.at(0)).not.toContain(failing)
    expect(runOxlintScan('/repo', scan, files, reportOnly(failing))).toEqual([
      diagnosticFor(failing)
    ])
  })

  // Why: Oxlint writes configuration failures to stdout, so swallowing it leaves the gate
  // dying with no reason in the log.
  it('surfaces what Oxlint printed when the output is not a report', () => {
    const failure = 'Failed to parse oxlint configuration file.\n\n  x Rule not found\n'

    expect(() => runOxlintScan('/repo', scan, ['src/a.ts'], () => failure)).toThrow(
      /Rule not found/
    )
  })

  // Why: the slice from the first brace to the last one takes a wrapper's own warning for
  // the report, and the raw SyntaxError names neither the scan nor the warning.
  it('surfaces a wrapper warning whose braces shadow the report', () => {
    const polluted = ` WARN  Unsupported engine: wanted: {"node":"24"}\n${JSON.stringify({ diagnostics: [] })}`

    expect(() => runOxlintScan('/repo', scan, ['src/a.ts'], () => polluted)).toThrow(
      /Unsupported engine/
    )
  })

  // Why: the whole point is that no single invocation carries the full argument list.
  it('never hands the whole oversized set to one invocation', () => {
    const batchSizes = observeBatches().map((batch) => batch.length)

    expect(batchSizes.length).toBeGreaterThan(1)
    expect(Math.max(...batchSizes)).toBeLessThan(files.length)
  })
})
