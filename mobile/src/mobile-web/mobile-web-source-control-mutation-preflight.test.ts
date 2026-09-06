import { describe, expect, it } from 'vitest'
import { assertMobileWebSourceControlMutationPreflight } from './mobile-web-source-control-mutation-preflight'

const entry = {
  relativePath: 'src/app.ts',
  status: 'modified' as const,
  area: 'unstaged' as const
}

describe('mobile web source-control mutation preflight', () => {
  it('accepts an exact provider-neutral target snapshot', () => {
    expect(() =>
      assertMobileWebSourceControlMutationPreflight({
        result: {
          head: 'a'.repeat(40),
          entries: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }]
        },
        expectedHead: 'a'.repeat(40),
        entries: [entry]
      })
    ).not.toThrow()
  })

  it('rejects changed heads, status areas, and missing paths', () => {
    for (const result of [
      {
        head: 'b'.repeat(40),
        entries: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }]
      },
      {
        head: 'a'.repeat(40),
        entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }]
      },
      { head: 'a'.repeat(40), entries: [] }
    ]) {
      expect(() =>
        assertMobileWebSourceControlMutationPreflight({
          result,
          expectedHead: 'a'.repeat(40),
          entries: [entry]
        })
      ).toThrow(expect.objectContaining({ code: 'conflict' }))
    }
  })

  it('ignores host-only fields while matching the safe snapshot', () => {
    expect(() =>
      assertMobileWebSourceControlMutationPreflight({
        result: {
          head: null,
          entries: [
            {
              path: 'src/app.ts',
              status: 'modified',
              area: 'unstaged',
              hostPath: '/private/repo/src/app.ts'
            }
          ]
        },
        expectedHead: null,
        entries: [entry]
      })
    ).not.toThrow()
  })
})
