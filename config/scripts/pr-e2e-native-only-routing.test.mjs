import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { hasNativeImeSourceChange, shouldRunReusablePrE2e } from './pr-e2e-source-routing.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const filterStep = workflow.jobs.code_paths.steps.find((step) => step.id === 'e2e_filter')

describe('native-only PR E2E routing', () => {
  it('avoids generic E2E allocation for native-only changes while preserving its IME lane', () => {
    for (const file of [
      'tests/e2e/terminal-ibus-hangul-native.spec.ts',
      'config/scripts/run-terminal-ibus-hangul-e2e.mjs'
    ]) {
      expect(hasNativeImeSourceChange([file])).toBe(true)
      expect(shouldRunReusablePrE2e([file])).toBe(false)
    }
    expect(shouldRunReusablePrE2e([])).toBe(false)
    for (const spec of [
      'tests/e2e/ssh-startup-exec-readiness.spec.ts',
      'tests/e2e/paired-startup-exec-readiness.spec.ts',
      'tests/e2e/terminal-ime-exact-byte.spec.ts',
      'tests/e2e/future.spec.ts'
    ]) {
      expect(shouldRunReusablePrE2e([spec])).toBe(true)
      expect(shouldRunReusablePrE2e(['tests/e2e/terminal-ibus-hangul-native.spec.ts', spec])).toBe(
        true
      )
    }
    expect(filterStep.run).toContain('pr-e2e-source-routing.mjs --reusable-workflow')
    expect(filterStep.run).toContain('if [ "$SHOULD_RUN" = true ]; then')
  })
})
