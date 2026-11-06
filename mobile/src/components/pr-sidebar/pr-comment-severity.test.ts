import { describe, expect, it } from 'vitest'
import { prCommentSeverity } from './pr-comment-severity'

describe('prCommentSeverity', () => {
  it.each([
    ['_⚠️ Potential issue_ | _🟠 Major_\n\n**Guard the null case.**', 'major'],
    ['_⚠️ Potential issue_ | _🔴 Critical_', 'critical'],
    ['_🧹 Nitpick_ | _🔵 Trivial_', 'trivial'],
    ['**Minor**: rename this.', 'minor'],
    ['_Major_', 'major']
  ])('reads the emphasised severity in %j', (body, expected) => {
    expect(prCommentSeverity(body)).toBe(expected)
  })

  it.each([
    'This is a minor race in the poller.',
    'Critical path: the merge button.',
    '_Majority_',
    'Bumps `semver_major_bump` in ci',
    'Set `ALLOW_MINOR_UPDATES` to true',
    ''
  ])('ignores the word outside a severity marker in %j', (body) => {
    expect(prCommentSeverity(body)).toBeNull()
  })
})
