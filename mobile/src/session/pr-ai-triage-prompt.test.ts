import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../src/shared/github/check-types'
import {
  buildFixChecksPrompt,
  buildResolveConflictsPrompt,
  getBrokenChecks,
  hasBrokenChecks
} from './pr-ai-triage-prompt'

function check(over: Partial<PRCheckDetail> = {}): PRCheckDetail {
  return {
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    url: 'https://ci/build',
    ...over
  }
}

describe('getBrokenChecks / hasBrokenChecks', () => {
  it('selects only failure/cancelled/timed_out conclusions', () => {
    const checks = [
      check({ name: 'ok', conclusion: 'success' }),
      check({ name: 'fail', conclusion: 'failure' }),
      check({ name: 'cancel', conclusion: 'cancelled' }),
      check({ name: 'timeout', conclusion: 'timed_out' }),
      check({ name: 'skip', conclusion: 'skipped' }),
      check({ name: 'pending', conclusion: 'pending' })
    ]
    expect(getBrokenChecks(checks).map((c) => c.name)).toEqual(['fail', 'cancel', 'timeout'])
    expect(hasBrokenChecks(checks)).toBe(true)
    expect(hasBrokenChecks([check({ conclusion: 'success' })])).toBe(false)
  })
})

describe('buildFixChecksPrompt', () => {
  // The wrapper only renames fields onto buildFixBrokenChecksPrompt, so assert the
  // mapping and nothing else; prompt wording is pinned by that builder's own tests.
  it('maps mobile PR fields onto the shared prompt builder', () => {
    const prompt = buildFixChecksPrompt({
      prNumber: 42,
      prTitle: 'Add feature',
      prUrl: 'https://gh/pr/42',
      checks: [
        check({ name: 'unit', conclusion: 'failure', checkRunId: 9, url: 'https://ci/unit' })
      ]
    })

    expect(prompt).toContain('"number": 42')
    expect(prompt).toContain('"title": "Add feature"')
    expect(prompt).toContain('"url": "https://gh/pr/42"')
    expect(prompt).toContain('"name": "unit"')
  })

  it('falls back to a refresh hint when nothing is broken', () => {
    const prompt = buildFixChecksPrompt({
      prNumber: 1,
      prTitle: 't',
      prUrl: 'u',
      checks: [check({ conclusion: 'success' })]
    })
    expect(prompt).toContain('No failing check is currently listed')
  })
})

describe('buildResolveConflictsPrompt', () => {
  it('includes the base branch and conflicted files for a simple ref', () => {
    const prompt = buildResolveConflictsPrompt({
      prNumber: 7,
      baseRef: 'main',
      files: ['src/a.ts', 'src/b.ts']
    })
    expect(prompt).toContain('Resolve the merge conflicts reported for this pull request')
    expect(prompt).toContain('"main"')
    expect(prompt).toContain('git fetch origin main')
    expect(prompt).toContain('origin/main')
    expect(prompt).toContain('"src/a.ts" (Conflict)')
    expect(prompt).toContain('Conflicted files reported by the pull request (2)')
    expect(prompt).toContain('git reset --hard') // safety rule mentions it as forbidden
  })

  it('handles a missing base ref and empty file list', () => {
    const prompt = buildResolveConflictsPrompt({ prNumber: 7, baseRef: null, files: [] })
    expect(prompt).toContain('unavailable from cached conflict details')
    expect(prompt).toContain('Identify the pull request base branch')
    expect(prompt).toContain('No conflicting files were reported')
  })

  it('quotes a non-simple ref without an unquoted git command', () => {
    const prompt = buildResolveConflictsPrompt({
      prNumber: 7,
      baseRef: 'feature branch with spaces',
      files: ['x']
    })
    expect(prompt).toContain('quoting the ref exactly for the current shell')
    expect(prompt).not.toContain('git fetch origin feature branch with spaces')
  })
})
