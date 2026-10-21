import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  OXLINT_SCANS,
  diagnosticTouchesAddedLines,
  findCastingDirectivesMissingSafety,
  isCastingDirectiveUnusedWarning
} from './check-changed-code-quality.mjs'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const oxlint = resolveOxlintInvocation(root)
const rule = 'typescript(consistent-type-assertions)'
const ruleName = 'typescript/consistent-type-assertions'
// Built rather than written out so no line here is itself a casting directive the gate would scan.
const directive = (reason) => `// oxlint-disable-next-line ${ruleName} -- ${reason}`
const trailingDirective = (reason) => `// oxlint-disable-line ${ruleName} -- ${reason}`

function lint(file, args = []) {
  const result = spawnSync(
    oxlint.command,
    [...oxlint.prefixArgs, ...args, '--format', 'json', file],
    { cwd: root, encoding: 'utf8', windowsHide: true }
  )
  expect(result.error).toBeUndefined()
  return { status: result.status, diagnostics: JSON.parse(result.stdout).diagnostics }
}

it.each(['config', 'mobile'])('enforces new casts without changing full lint in %s', (parent) => {
  const directory = mkdtempSync(path.join(root, parent, 'casting-lint-test-'))
  const file = path.join(directory, 'fixture.test.ts')
  try {
    writeFileSync(
      file,
      [
        "export const oldCast = { current: '⌘N' as string | null }",
        'export const doubleCast = undefined as unknown as string',
        "export const annotated: { current: string | null } = { current: '⌘N' }",
        "export const constant = { current: '⌘N' } as const",
        "export const checked = { current: '⌘N' } satisfies { current: string | null }",
        directive('SAFETY: Exercise the explicit exception.'),
        'export const justified = undefined as unknown'
      ].join('\n')
    )

    const full = lint(file)
    expect(full.status).toBe(0)
    expect(full.diagnostics.filter((diagnostic) => diagnostic.code === rule)).toEqual([])

    const scan = OXLINT_SCANS.find((candidate) => candidate.label === 'casting code quality')
    expect(scan).toBeDefined()
    const casting = lint(file, scan.args)
    expect(casting.status).toBe(1)
    expect(casting.diagnostics).toHaveLength(3)
    expect(casting.diagnostics.every((diagnostic) => diagnostic.code === rule)).toBe(true)

    const relative = path.relative(root, file).split(path.sep).join('/')
    const changed = new Map([[relative, [{ start: 2, end: 2 }]]])
    const findings = casting.diagnostics.filter((diagnostic) =>
      diagnosticTouchesAddedLines(diagnostic, changed, root)
    )
    expect(findings).toHaveLength(2)
    expect(findings.every((diagnostic) => diagnostic.severity === 'error')).toBe(true)

    writeFileSync(file, 'export const angle = <string>undefined\n')
    expect(lint(file).status).toBe(1)
    expect(lint(file, scan.args).diagnostics.map((diagnostic) => diagnostic.code)).toEqual([rule])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("exempts the SAFETY: directive from the untyped scan's unused-directive warning", () => {
  const directory = mkdtempSync(path.join(root, 'config', 'casting-lint-test-'))
  const file = path.join(directory, 'fixture.test.ts')
  try {
    writeFileSync(
      file,
      [
        directive('SAFETY: Verified invariant.'),
        'export const justified = undefined as unknown',
        ''
      ].join('\n')
    )

    const scan = OXLINT_SCANS.find((candidate) => candidate.label === 'code quality')
    const untyped = lint(file, scan.args)
    const unused = untyped.diagnostics.filter((diagnostic) =>
      diagnostic.message.startsWith('Unused oxlint-disable directive')
    )

    expect(unused).toHaveLength(1)
    expect(unused.every((diagnostic) => isCastingDirectiveUnusedWarning(diagnostic, root))).toBe(
      true
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('rejects a casting suppression on an added line that omits the SAFETY: rationale', () => {
  const directory = mkdtempSync(path.join(root, 'config', 'casting-lint-test-'))
  const file = path.join(directory, 'fixture.test.ts')
  try {
    writeFileSync(
      file,
      [
        directive('no required prefix'),
        'export const unchecked = undefined as unknown',
        directive('SAFETY: Verified invariant.'),
        'export const justified = undefined as unknown',
        ''
      ].join('\n')
    )

    const relative = path.relative(root, file).split(path.sep).join('/')
    const findings = findCastingDirectivesMissingSafety(
      root,
      new Map([[relative, [{ start: 1, end: 4 }]]])
    )

    expect(findings.map((finding) => finding.labels[0].span.line)).toEqual([1])

    // Unchanged lines stay out of the gate.
    expect(
      findCastingDirectivesMissingSafety(root, new Map([[relative, [{ start: 3, end: 4 }]]]))
    ).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// Why: an earlier pattern skipped a directive whose `//` sat right after a quote, which let an
// unjustified cast through the gate -- the wrong failure direction for a gate.
it('catches a trailing casting suppression that abuts a string literal', () => {
  const directory = mkdtempSync(path.join(root, 'config', 'casting-lint-test-'))
  const file = path.join(directory, 'fixture.test.ts')
  try {
    writeFileSync(file, `export const abutted = 'a'${trailingDirective('no required prefix')}\n`)

    const relative = path.relative(root, file).split(path.sep).join('/')
    const findings = findCastingDirectivesMissingSafety(
      root,
      new Map([[relative, [{ start: 1, end: 1 }]]])
    )

    expect(findings.map((finding) => finding.labels[0].span.line)).toEqual([1])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
