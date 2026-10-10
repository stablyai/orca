import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const harness = 'src/renderer/src/runtime/web-session-tabs-sync-test-harness.ts'

describe('shared web-session unit support routing', () => {
  it('keeps unit checks and lint while excluding packaging for the exact harness', () => {
    const result = classifyPrJobs([harness])
    expect(result.should_run).toBe(true)
    expect(result.static_analysis).toBe(true)
    expect(result.typecheck).toBe(true)
    expect(result.test).toBe(true)
    expect(result.package).toBe(false)
    expect(result.package_windows).toBe(false)
  })

  it('retains packaging for unknown helpers and mixed product changes', () => {
    for (const file of [
      'src/renderer/src/runtime/web-session-tabs-sync-next-test-harness.ts',
      'src/renderer/src/runtime/web-session-tabs-sync.ts'
    ]) {
      const result = classifyPrJobs([harness, file])
      expect(result.should_run, file).toBe(true)
      expect(result.test, file).toBe(true)
      expect(result.package, file).toBe(true)
      expect(result.package_windows, file).toBe(true)
    }
  })

  it('does not turn the exact unit harness into a two-app E2E', () => {
    expect(selectPrE2eSpecs([harness])).toEqual([])
  })

  it('retains E2E selection for unknown helpers, product changes and selected specs', () => {
    const spec = 'tests/e2e/paired-client-hosted-browser-restart-survival.spec.ts'
    for (const file of [
      'src/renderer/src/runtime/web-session-tabs-sync-next-test-harness.ts',
      'src/renderer/src/runtime/web-session-tabs-sync.ts',
      spec
    ]) {
      expect(selectPrE2eSpecs([harness, file]), file).toContain(spec)
    }
  })
})
