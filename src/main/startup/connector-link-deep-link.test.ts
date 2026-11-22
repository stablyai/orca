import { describe, expect, it } from 'vitest'
import { formatConnectorLinkDeepLink, parseConnectorLinkDeepLink } from './connector-link-deep-link'

describe('parseConnectorLinkDeepLink', () => {
  const token = `${'aB3_-'.repeat(8)}xyz`

  it("reads the result from a connect trip's Open Orca, for Linear and GitHub", () => {
    expect(parseConnectorLinkDeepLink(`orca://linear/link?t=${token}`)).toEqual({
      source: 'linear',
      token
    })
    expect(parseConnectorLinkDeepLink(`orca://linear/link/?t=${token}`)).toEqual({
      source: 'linear',
      token
    })
    expect(parseConnectorLinkDeepLink(`orca://github/link?t=${token}`)).toEqual({
      source: 'github',
      token
    })
    for (const source of ['linear', 'github'] as const) {
      expect(parseConnectorLinkDeepLink(formatConnectorLinkDeepLink({ source, token }))).toEqual({
        source,
        token
      })
    }
  })

  it.each([
    'orca://linear/link',
    'orca://linear/link?t=short',
    'orca://github/link?t=a%2Fbcdefghijklmnopqrstu',
    `orca://linear/install?t=${'a'.repeat(43)}`,
    `orca://bot/link?t=${'a'.repeat(43)}`,
    `orca://slack/link?t=${'a'.repeat(43)}`,
    `orca://constructor/link?t=${'a'.repeat(43)}`,
    `https://linear.app/link?t=${'a'.repeat(43)}`,
    `https://github.com/link?t=${'a'.repeat(43)}`
  ])('rejects %s', (value) => {
    expect(parseConnectorLinkDeepLink(value)).toBeNull()
  })
})
