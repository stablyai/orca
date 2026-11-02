import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { MAX_SCOPED_FILES, planLintScope } from './lint-change-scope.mjs'

const exists = (file) => !file.startsWith('deleted/') && !file.includes('/deleted-')

describe('per-file lint scope', () => {
  it.each([
    '.oxlintrc.json',
    'mobile/.oxlintrc.json',
    'docs/site/.oxlintrc.json',
    'config/oxlint-js-plugins.json',
    'config/oxlint-anti-slop.json',
    'config/oxlint-plugins/ime-enter-guard.mjs',
    'config/sgconfig.yml',
    'config/ast-grep/rules/no-repeated-collator.yml',
    'config/flaky-test-pattern-baseline.txt',
    '.oxfmtrc.json',
    '.gitignore',
    'package.json',
    'mobile/package.json',
    'pnpm-lock.yaml',
    '.github/workflows/pr.yml',
    'config/scripts/ast-grep-gates.mjs',
    'config/scripts/lint-change-scope.mjs'
  ])('checks everything when a lint toolchain input changes: %s', (file) => {
    expect(planLintScope(['src/main/a.ts', file], { exists }).scope).toBe('full')
  })

  it('checks everything when the diff is empty or too large to scope', () => {
    expect(planLintScope([], { exists }).scope).toBe('full')
    const many = Array.from({ length: MAX_SCOPED_FILES + 1 }, (_, i) => `src/main/f${i}.ts`)
    expect(planLintScope(many, { exists }).scope).toBe('full')
  })

  it('routes existing changed paths to each pass by its scanned roots', () => {
    const plan = planLintScope(
      [
        'src/main/a.ts',
        'src/main/deleted-b.ts',
        'docs/guide.md',
        '.github/scripts/check.mjs',
        'native/addon.ts',
        'mobile/src/c.tsx',
        'src/main/a.ts'
      ],
      { exists }
    )
    expect(plan.scope).toBe('changed')
    expect(plan.passes).toEqual({
      oxlint: [
        '.github/scripts/check.mjs',
        'docs/guide.md',
        'mobile/src/c.tsx',
        'native/addon.ts',
        'src/main/a.ts'
      ],
      'js-plugins': [
        '.github/scripts/check.mjs',
        'mobile/src/c.tsx',
        'native/addon.ts',
        'src/main/a.ts'
      ],
      'anti-slop': ['mobile/src/c.tsx', 'src/main/a.ts'],
      'ast-grep': ['mobile/src/c.tsx', 'src/main/a.ts'],
      oxfmt: [
        '.github/scripts/check.mjs',
        'docs/guide.md',
        'mobile/src/c.tsx',
        'native/addon.ts',
        'src/main/a.ts'
      ]
    })
  })

  it('leaves every pass empty when only deleted paths changed', () => {
    const plan = planLintScope(['deleted/a.ts', 'src/main/deleted-b.ts'], { exists })
    expect(plan.scope).toBe('changed')
    expect(Object.values(plan.passes).every((files) => files.length === 0)).toBe(true)
  })

  it('lints all of docs/site, whose import rules read sibling modules', () => {
    const plan = planLintScope(['docs/site/src/page.tsx', 'src/main/a.ts'], { exists })
    expect(plan.passes.oxlint).toEqual(['src/main/a.ts', 'docs/site'])
    expect(plan.passes.oxfmt).toEqual(['docs/site/src/page.tsx', 'src/main/a.ts'])
  })
})

describe('preflight lint scope wiring', () => {
  const steps = parse(readFileSync('.github/workflows/pr.yml', 'utf8')).jobs.preflight.steps
  const select = steps.find((step) => step.id === 'lint-scope')

  it('scopes only pull requests, and falls back to everything when detection fails', () => {
    expect(select.run).toContain('scope=full')
    expect(select.run).toContain('[ "$GITHUB_EVENT_NAME" = pull_request ]')
    expect(select.run).toContain('git diff --name-only --no-renames -z "$DIFF_BASE" HEAD')
    expect(select.run).toContain('|| scope=full')
  })

  it.each([
    ['root-lint', 'oxlint'],
    ['js-plugin-lint', 'js-plugins'],
    ['anti-slop', 'anti-slop']
  ])('%s reads its own changed paths and tolerates all-ignored selections', (id, pass) => {
    const step = steps.find((candidate) => candidate.id === id)
    expect(step.env.LINT_SCOPE).toBe('${{ steps.lint-scope.outputs.scope }}')
    expect(step.run).toContain(`"$RUNNER_TEMP/lint-scope/${pass}"`)
    expect(step.run).toContain('--no-error-on-unmatched-pattern "${paths[@]}"')
  })

  it('keeps whole-program passes unscoped', () => {
    for (const name of [
      'Enforce focused code-quality plugins',
      'Enforce type-aware code-quality baseline',
      'Check process-host imports',
      'Enforce dead design-system classes'
    ]) {
      const step = steps.find((candidate) => candidate.name === name)
      expect(step.env?.LINT_SCOPE, name).toBeUndefined()
    }
  })
})
