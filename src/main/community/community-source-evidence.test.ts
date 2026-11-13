import { expect, it } from 'vitest'
import { communityEvidenceSignals } from './community-evidence-signals'
import { captureCommunitySourceDiff } from './community-source-diff'
const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const old = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const at = '2026-11-12T10:00:00.000Z'
it('does not turn missing or incomplete check evidence into a pass', () => {
  const evidence = {
    checks: [],
    checksObserved: false,
    checksComplete: false,
    reviews: [],
    reviewsObserved: false,
    reviewsComplete: false
  }
  expect(communityEvidenceSignals(head, evidence, at)).toEqual({
    headSha: head,
    capturedAt: at,
    checks: 'unknown',
    review: 'unknown'
  })
})
it('keeps approval on an earlier head separate from approval of the inspected code', () => {
  const evidence = {
    checks: [{ name: 'test', state: 'success', url: null }],
    checksObserved: true,
    checksComplete: true,
    reviews: [
      {
        author: 'reviewer',
        state: 'APPROVED',
        commit: old,
        at,
        url: 'https://github.com/stablyai/orca/pull/42#review-1'
      }
    ],
    reviewsObserved: true,
    reviewsComplete: true
  }
  expect(communityEvidenceSignals(head, evidence, at)).toMatchObject({
    checks: 'passed',
    review: 'none'
  })
})
it('preserves a failed check even when another check passed', () => {
  const evidence = {
    checks: [
      { name: 'test', state: 'failure', url: null },
      { name: 'lint', state: 'success', url: null }
    ],
    checksObserved: true,
    checksComplete: true,
    reviews: [],
    reviewsObserved: true,
    reviewsComplete: true
  }
  expect(communityEvidenceSignals(head, evidence, at).checks).toBe('attention')
})
it('reports incomplete text coverage when a changed binary has no patch', async () => {
  const source = {
    request: async () => ({
      files: [
        { filename: 'src/image.png', status: 'modified' },
        { filename: 'src/view.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }
      ]
    })
  }
  const diff = await captureCommunitySourceDiff(source, old, head, 2, new AbortController().signal)
  expect(diff).toEqual({
    baseSha: old,
    headSha: head,
    complete: false,
    files: [
      { path: 'src/image.png', status: 'modified', patch: null },
      { path: 'src/view.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }
    ]
  })
})
