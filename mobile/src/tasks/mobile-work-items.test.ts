import { describe, expect, it } from 'vitest'
import { isGitHubWorkItemsSshRemoteRequiredError } from './mobile-work-items'

describe('isGitHubWorkItemsSshRemoteRequiredError', () => {
  it('matches the canonical English backend sentinel regardless of UI language', () => {
    expect(
      isGitHubWorkItemsSshRemoteRequiredError(
        new Error('GitHub work items require a GitHub remote for SSH repositories')
      )
    ).toBe(true)
  })

  it('does not treat localized UI text as the protocol sentinel', () => {
    expect(
      isGitHubWorkItemsSshRemoteRequiredError(
        new Error('GitHub 工作项需要 SSH 存储库的 GitHub 远程')
      )
    ).toBe(false)
  })
})
