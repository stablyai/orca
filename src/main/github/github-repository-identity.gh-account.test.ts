import { describe, expect, it } from 'vitest'
import { ghRepoExecOptions, githubRepoContext } from './github-repository-identity'

describe('ghRepoExecOptions ghAccount threading', () => {
  it('keeps ghAccount when cwd is present for local repos', () => {
    expect(
      ghRepoExecOptions(
        githubRepoContext('/repo', null, {
          wslDistro: 'Ubuntu',
          ghAccount: { host: 'github.com', user: 'Alice' }
        })
      )
    ).toEqual({
      cwd: '/repo',
      wslDistro: 'Ubuntu',
      ghAccount: { host: 'github.com', user: 'Alice' }
    })
  })

  it('keeps ghAccount when SSH omits cwd', () => {
    expect(
      ghRepoExecOptions(
        githubRepoContext('/remote/repo', 'ssh-1', {
          ghAccount: { host: 'github.acme.com', user: 'Bob' }
        })
      )
    ).toEqual({
      ghAccount: { host: 'github.acme.com', user: 'Bob' }
    })
  })
})
