import { describe, expect, it } from 'vitest'
import { getCreateReferenceInputs, parseReferenceUrls } from './reference-input'

const SELF_HOSTED_ISSUE = 'https://gitea.example.com/org/repo/issues/42'

describe('reference provider hint', () => {
  it('resolves an ambiguous self-hosted issue URL when the forge is named', () => {
    expect(parseReferenceUrls([SELF_HOSTED_ISSUE], 'gitea')).toEqual([
      {
        provider: 'gitea',
        type: 'issue',
        number: 42,
        url: SELF_HOSTED_ISSUE
      }
    ])
  })

  it('uses the hint only for URLs whose host cannot name a provider', () => {
    const references = parseReferenceUrls(
      [SELF_HOSTED_ISSUE, 'https://github.com/acme/api/pull/5123'],
      'gitea'
    )

    expect(references.map((reference) => reference.provider)).toEqual(['gitea', 'github'])
  })

  it('carries the flag into worktree create references', () => {
    const inputs = getCreateReferenceInputs(
      new Map<string, string | boolean>([
        ['reference', SELF_HOSTED_ISSUE],
        ['reference-provider', 'gitea']
      ])
    )

    expect(inputs).toEqual([
      { item: { provider: 'gitea', type: 'issue', number: 42, url: SELF_HOSTED_ISSUE } }
    ])
  })

  it('refuses a provider without a reference or an unknown provider', () => {
    expect(() => getCreateReferenceInputs(new Map([['reference-provider', 'gitea']]))).toThrow(
      '--reference-provider requires --reference.'
    )
    expect(() =>
      getCreateReferenceInputs(
        new Map([
          ['reference', SELF_HOSTED_ISSUE],
          ['reference-provider', 'forgejo']
        ])
      )
    ).toThrow('--reference-provider must be github or gitea.')
  })
})
