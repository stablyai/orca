import { describe, expect, it } from 'vitest'
import { resolvePtyViewAttributeScope } from './pty-view-attribute-scope'

describe('resolvePtyViewAttributeScope', () => {
  it('prefers the runtime record over the pty id', () => {
    expect(
      resolvePtyViewAttributeScope('repo9::/z@@abc', {
        worktreeId: 'repo1::/p',
        connectionId: 'c1'
      })
    ).toEqual({ worktreeId: 'repo1::/p', connectionId: 'c1' })
  })

  it('infers the worktree from a daemon pty id before graph sync', () => {
    expect(resolvePtyViewAttributeScope('repo1::/p@@abc', undefined)).toEqual({
      worktreeId: 'repo1::/p',
      connectionId: null
    })
  })

  it('infers the SSH connection from an app SSH pty id', () => {
    expect(resolvePtyViewAttributeScope('ssh:target-1@@pty-1', undefined).connectionId).toBe(
      'target-1'
    )
  })

  it('returns nulls for an opaque pty id', () => {
    expect(resolvePtyViewAttributeScope('pty-1', undefined)).toEqual({
      worktreeId: null,
      connectionId: null
    })
  })
})
