import { describe, expect, it } from 'vitest'
import { refreshKey } from './pull-requests/refresh/pr-refresh-candidate-policy'

const candidate = { repoPath: '/repo', branch: 'feature', linkedPRNumber: 42 }

describe('PR refresh account isolation', () => {
  it('separates different accounts and coalesces equivalent account spellings', () => {
    const key = (user: string, host = 'github.com') =>
      refreshKey({ ...candidate, localGitOptions: { ghAccount: { host, user } } })
    expect(new Set([key('Alice'), key('Bob'), refreshKey(candidate)]).size).toBe(3)
    expect(key(' Alice ', ' GitHub.COM ')).toBe(key('Alice'))
    expect(key('alice')).not.toBe(key('Alice'))
    expect(key('Alice', 'github.example.com')).not.toBe(key('Alice'))
  })
})
