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
  it('names the base branch and repository, and leaves listing the files to Git', () => {
    const prompt = buildResolveConflictsPrompt({
      baseRef: 'main',
      baseRepository: { owner: 'acme', repo: 'widgets', host: 'github.com' }
    })
    expect(prompt).toContain('Resolve the merge conflicts reported for this pull request')
    expect(prompt).toContain('- PR base: branch "main" of repository "acme/widgets"')
    expect(prompt).toContain('Find the remote whose URL points at "acme/widgets"')
    expect(prompt).toContain('git fetch <remote> main')
    expect(prompt).toContain('Git lists them once the merge below stops')
    expect(prompt).toContain(
      'the conflicts may already be resolved in local commits that have not been pushed, or the host'
    )
    expect(prompt).toContain('may be stale. Do not push.')
    expect(prompt).not.toContain('git fetch origin')
    expect(prompt).toContain('git reset --hard') // safety rule mentions it as forbidden
  })

  it('handles a missing base ref and repository', () => {
    const prompt = buildResolveConflictsPrompt({ baseRef: null, baseRepository: null })
    expect(prompt).toContain('- PR base branch: unavailable')
    expect(prompt).toContain('Identify the pull request base branch')
    expect(prompt).toContain('Use the remote that hosts this pull request.')
  })

  it('quotes a non-simple ref without an unquoted git command', () => {
    const prompt = buildResolveConflictsPrompt({ baseRef: 'feature branch with spaces' })
    expect(prompt).toContain('quoting the ref exactly for the current shell')
    expect(prompt).not.toContain('git fetch <remote> feature branch with spaces')
  })
})
