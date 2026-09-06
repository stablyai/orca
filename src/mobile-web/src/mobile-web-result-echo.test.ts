import { describe, expect, it } from 'vitest'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'

describe('mobile web result echo', () => {
  it('returns a result whose workspace matches the request', () => {
    const result = { workspaceId: 'workspace-1', value: 3 }

    expect(requireEchoedWorkspaceId('workspace-1', result)).toBe(result)
  })

  it('rejects a result addressed to another workspace', () => {
    expect(() => requireEchoedWorkspaceId('workspace-1', { workspaceId: 'workspace-2' })).toThrow(
      expect.objectContaining({ code: 'invalid_message', retryable: false })
    )
  })
})
