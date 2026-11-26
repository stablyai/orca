import { describe, expect, it } from 'vitest'
import { getWorkspaceUrlFlag } from './worktree-set'

describe('getWorkspaceUrlFlag', () => {
  it.each([
    ['https://app.test/admin?x=1', 'https://app.test/admin?x=1'],
    ['null', '']
  ])('maps --url %s to workspaceUrl %s', (flag, expected) => {
    expect(getWorkspaceUrlFlag(new Map([['url', flag]]))).toBe(expected)
  })

  it('leaves workspaceUrl unset without --url', () => {
    expect(getWorkspaceUrlFlag(new Map())).toBeUndefined()
  })

  it('rejects a non-http --url', () => {
    expect(() => getWorkspaceUrlFlag(new Map([['url', 'app.test']]))).toThrow(/http\(s\)/)
  })
})
