import { describe, expect, it } from 'vitest'
import type { SkillBundleInstallResult } from '../../shared/skill-bundle-install-contract'
import { summarizeSkillBundleObservation } from './skill-bundle-observability-summary'

describe('skill bundle observability summary', () => {
  it('caps distinct error categories while preserving the aggregate count', () => {
    const result: SkillBundleInstallResult = {
      operationId: 'operation',
      packageId: 'package',
      versionId: 'version',
      bundleDigest: 'a'.repeat(64),
      status: 'failed',
      skills: Array.from({ length: 40 }, (_, index) => ({
        skillId: `skill-${index}`,
        name: `skill-${index}`,
        digest: 'b'.repeat(64),
        status: 'failed' as const,
        placements: [],
        errorCategory: `skill-error-${index}`
      }))
    }

    const summary = summarizeSkillBundleObservation(result)

    expect(summary.errorCategories.size).toBe(32)
    expect([...summary.errorCategories.values()].reduce((total, count) => total + count, 0)).toBe(
      40
    )
  })
})
