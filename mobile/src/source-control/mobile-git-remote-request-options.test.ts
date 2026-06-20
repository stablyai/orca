import { describe, expect, it } from 'vitest'
import { GIT_REMOTE_OPERATION_RPC_TIMEOUT_MS } from '../../../src/shared/git-remote-operation-timeout'
import { mobileGitRequestOptions } from './mobile-git-remote-request-options'

describe('mobile remote git request options', () => {
  it.each([
    'git.fetch',
    'git.forkSync',
    'git.push',
    'git.pull',
    'git.fastForward',
    'git.rebaseFromBase'
  ])('uses the bounded remote-operation deadline for %s', (method) => {
    expect(mobileGitRequestOptions(method)).toEqual({
      timeoutMs: GIT_REMOTE_OPERATION_RPC_TIMEOUT_MS
    })
  })

  it('keeps local git requests on the default transport deadline', () => {
    expect(mobileGitRequestOptions('git.status')).toBeUndefined()
  })
})
