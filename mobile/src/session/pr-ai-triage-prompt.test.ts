import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../src/shared/github/check-types'
import { buildFixChecksPrompt, buildResolveConflictsPrompt } from './pr-ai-triage-prompt'

// The shared builders own prompt wording; these pin only what mobile feeds them.
describe('buildFixChecksPrompt', () => {
  it("carries a broken check's failing log tail, like desktop", async () => {
    const failing: PRCheckDetail = {
      name: 'unit',
      status: 'completed',
      conclusion: 'failure',
      url: 'https://ci/unit',
      checkRunId: 9
    }
    const prompt = await buildFixChecksPrompt({
      prNumber: 42,
      prTitle: 'Add feature',
      prUrl: 'https://gh/pr/42',
      checks: [failing],
      loadCheckDetails: async () => ({
        name: 'unit',
        status: 'completed',
        conclusion: 'failure',
        url: 'https://ci/unit',
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        title: null,
        summary: null,
        text: null,
        annotations: [],
        jobs: [
          {
            id: 1,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            startedAt: null,
            completedAt: null,
            url: null,
            steps: [],
            logTail: 'AssertionError: expected 1 to be 2',
            logState: 'available'
          }
        ]
      })
    })
    expect(prompt).toContain('AssertionError: expected 1 to be 2')
  })
})

describe('buildResolveConflictsPrompt', () => {
  it('names the worktree path, like desktop', () => {
    const prompt = buildResolveConflictsPrompt({
      prNumber: 7,
      baseRef: 'main',
      files: ['src/a.ts'],
      worktreeId: 'repo-1::/Users/me/wt'
    })
    expect(prompt).toContain('"/Users/me/wt"')
  })
})
