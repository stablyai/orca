import { describe, expect, it } from 'vitest'
import { prCommentSeverity } from './pr-comment-severity'

describe('prCommentSeverity', () => {
  it.each([
    ['_⚠️ Potential issue_ | _🟠 Major_\n\n**Guard the null case.**', 'major'],
    ['_🧹 Nitpick_ | _🔵 Trivial_', 'trivial'],
    ['**Minor**: rename this.', 'minor'],
    ['_Major_', 'major']
  ])('reads the emphasised severity in %j', (body, expected) => {
    expect(prCommentSeverity(body)).toBe(expected)
  })

  it.each([
    'This is a minor race in the poller.',
    '_Majority_',
    'Set `ALLOW_MINOR_UPDATES` to true'
  ])('ignores the word outside a severity marker in %j', (body) => {
    expect(prCommentSeverity(body)).toBeNull()
  })
})
