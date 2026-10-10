import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'
import {
  OXLINT_SCANS,
  collectBaseLineBlocks,
  diagnosticTouchesAddedLines,
  isUnloadedPluginDirectiveUnusedWarning,
  isMovedCode,
  isRootCodeQualityPath,
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

  // Why: import/no-duplicates was reachable only through the repo-wide CI audit, so it first
  // surfaced after push. The cycle rule stays out because CI's audit runs before the mobile install.
  it('runs the focused plugin config the repo-wide audit enforces, minus the cycle rule', () => {
    const scan = OXLINT_SCANS.find((candidate) => candidate.label === 'focused plugins')

    expect(scan.args).toContain('config/oxlint-code-quality-native-plugins.json')
    expect(scan.args).toContain('import/no-cycle')
    expect(scan.args[scan.args.indexOf('import/no-cycle') - 1]).toBe('--allow')
  })

  it('leaves Cloud source to the independent Cloud quality checks', () => {
    expect(isRootCodeQualityPath('cloud/apps/relay/src/index.ts')).toBe(false)
    expect(isRootCodeQualityPath('src/main/index.ts')).toBe(true)
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

  it('reads the base text of a file that was renamed away', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'changed-code-quality-rename-'))
    try {
      const git = (...args) => {
        const result = runProcessSync({
          program: 'git',
          args: ['-c', 'commit.gpgsign=false', ...args],
          cwd: repo
        })
        expect(result.code, result.stderr).toBe(0)
        return result.stdout.trim()
      }
      git('init', '--quiet')
      writeFileSync(path.join(repo, 'old.ts'), 'const moved = value as Thing\n')
      git('add', 'old.ts')
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD')
      git('mv', 'old.ts', 'new.ts')

      expect(collectBaseLineBlocks(repo, base)).toEqual([['const moved = value as Thing']])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('unloaded plugin directive unused warning', () => {
  const root = path.resolve(import.meta.dirname, '..', '..')
  // Assembled so no line here is itself a directive the gate would scan.
  const directive = (rule) => `/* oxlint-disable ${rule} -- reason */`

  const withFixture = (firstLine, assert, filename = 'fixture.ts') => {
    const directory = mkdtempSync(path.join(root, 'config', 'anti-slop-directive-test-'))
    try {
      const file = path.join(directory, filename)
      writeFileSync(file, [firstLine, 'export const value = 1', ''].join('\n'))
      assert({
        message: 'Unused oxlint-disable directive (no problems were reported).',
        filename: file,
        labels: [{ span: { line: 1 } }]
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  it('exempts a suppression the root scan cannot resolve', () => {
    withFixture(directive('anti-slop/no-module-mocking'), (diagnostic) => {
      expect(isUnloadedPluginDirectiveUnusedWarning(diagnostic, root, 'code quality')).toBe(true)
    })
  })

  it('still reports an unused directive for a rule the root scan does load', () => {
    withFixture(directive('unicorn/no-array-reduce'), (diagnostic) => {
      expect(isUnloadedPluginDirectiveUnusedWarning(diagnostic, root, 'code quality')).toBe(false)
    })
  })

  it('ignores diagnostics that are not unused-directive warnings', () => {
    withFixture(directive('anti-slop/no-module-mocking'), (diagnostic) => {
      expect(
        isUnloadedPluginDirectiveUnusedWarning(
          { ...diagnostic, message: 'Unexpected any.' },
          root,
          'code quality'
        )
      ).toBe(false)
    })
  })

  function scanFixture(label, file) {
    const scan = OXLINT_SCANS.find((candidate) => candidate.label === label)
    if (!scan) {
      throw new Error(`Missing ${label} scan`)
    }
    const { command, prefixArgs } = resolveOxlintInvocation(root)
    const result = runProcessSync({
      program: command,
      args: [...prefixArgs, ...scan.args, '--format', 'json', file],
      cwd: root,
      timeoutMs: 30_000,
      maxOutputBytes: 4 * 1024 * 1024
    })
    return JSON.parse(result.stdout).diagnostics
  }

  it.each([
    "import './web-session-tabs-sync-test-harness'",
    "export * from '@/runtime/web-session-tabs-sync-test-harness'",
    "void import('@renderer/runtime/web-session-tabs-sync-test-harness.ts')",
    "import '../runtime/web-runtime-browser-creation-placement-test-rig'"
  ])('rejects unit-support imports in production source: %s', (source) => {
    withFixture(source, ({ filename }) => {
      const diagnostics = scanFixture('code quality', filename).filter(
        (diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)'
      )
      expect(diagnostics).toHaveLength(1)
    })
  })

  it.each(['fixture.test.ts', 'fixture.spec.ts'])(
    'allows unit-support imports from the existing test convention: %s',
    (filename) => {
      withFixture(
        "import '@/runtime/web-session-tabs-sync-test-harness'",
        (diagnostic) => {
          const diagnostics = scanFixture('code quality', diagnostic.filename).filter(
            (finding) => finding.code === 'eslint(no-restricted-imports)'
          )
          expect(diagnostics).toEqual([])
        },
        filename
      )
    }
  )

  it('accepts a used Doctor directive only through its loaded scan', () => {
    const source = [
      "import { useEffect, useState } from 'react'",
      directive('react-doctor/no-derived-state-effect'),
      'export function Title({ title }: { title: string }) {',
      "  const [value, setValue] = useState('')",
      '  useEffect(() => { setValue(title) }, [title])',
      '  return value',
      '}'
    ].join('\n')
    withFixture(source, ({ filename }) => {
      const normal = scanFixture('code quality', filename)
      const unused = normal.find((diagnostic) => diagnostic.message.startsWith('Unused '))
      expect(unused).toBeDefined()
      expect(isUnloadedPluginDirectiveUnusedWarning(unused, root, 'code quality')).toBe(true)
      expect(scanFixture('React Doctor', filename)).toEqual([])
    })
  })

  it('keeps an unused Doctor directive failing in its loaded scan', () => {
    withFixture(directive('react-doctor/no-derived-state-effect'), ({ filename }) => {
      const diagnostics = scanFixture('React Doctor', filename)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0].message).toMatch(/^Unused /)
      expect(isUnloadedPluginDirectiveUnusedWarning(diagnostics[0], root, 'React Doctor')).toBe(
        false
      )
    })
  })

  it('does not hide unused native rules in a mixed directive', () => {
    withFixture(
      directive('react-doctor/no-derived-state-effect, unicorn/no-array-reduce'),
      (diagnostic) => {
        expect(isUnloadedPluginDirectiveUnusedWarning(diagnostic, root, 'code quality')).toBe(false)
      }
    )
  })

  it('recognizes a standalone directive containing only Doctor rules', () => {
    withFixture(
      directive(
        'react-doctor/no-derived-state-effect, react-doctor/no-adjust-state-on-prop-change'
      ),
      (diagnostic) => {
        expect(isUnloadedPluginDirectiveUnusedWarning(diagnostic, root, 'code quality')).toBe(true)
      }
    )
  })

  it('keeps adjacent native directive warnings visible', () => {
    const doctor = directive('react-doctor/no-derived-state-effect')
    const native = directive('unicorn/no-array-reduce')
    for (const source of [`${doctor} ${native}`, `${native} ${doctor}`]) {
      withFixture(source, ({ filename }) => {
        const diagnostic = scanFixture('code quality', filename).find((candidate) =>
          candidate.labels.some((label) => label.span.offset === source.indexOf(native))
        )
        expect(diagnostic).toBeDefined()
        expect(diagnostic.message).toMatch(/^Unused /)
        expect(isUnloadedPluginDirectiveUnusedWarning(diagnostic, root, 'code quality')).toBe(false)
      })
    }
  })

  it('leaves used native directives to the scan that loads them', () => {
    withFixture(
      [
        'export const banner = "λ"',
        directive('typescript/no-explicit-any'),
        'export const answer: any = 42'
      ].join('\n'),
      ({ filename }) => {
        expect(scanFixture('code quality', filename)).toEqual([])
        const diagnostics = scanFixture('React Doctor', filename)
        expect(diagnostics).toHaveLength(1)
        expect(isUnloadedPluginDirectiveUnusedWarning(diagnostics[0], root, 'React Doctor')).toBe(
          true
        )
      }
    )
  })

  it('does not exempt unused Doctor rules together with unloaded native rules', () => {
    withFixture(
      directive('react-doctor/no-derived-state-effect, typescript/no-explicit-any'),
      ({ filename }) => {
        const diagnostics = scanFixture('React Doctor', filename)
        expect(diagnostics).toHaveLength(1)
        expect(isUnloadedPluginDirectiveUnusedWarning(diagnostics[0], root, 'React Doctor')).toBe(
          false
        )
      }
    )
  })

  it('keeps blanket unused directives visible in the Doctor scan', () => {
    for (const source of [directive(''), '// oxlint-disable-next-line -- reason']) {
      withFixture(source, ({ filename }) => {
        const diagnostics = scanFixture('React Doctor', filename)
        expect(diagnostics).toHaveLength(1)
        expect(isUnloadedPluginDirectiveUnusedWarning(diagnostics[0], root, 'React Doctor')).toBe(
          false
        )
      })
    }
  })
})
