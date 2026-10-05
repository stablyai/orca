import { describe, expect, it } from 'vitest'
import {
  fileOwnershipSshStateSchema,
  fileOwnershipWorktreeSchema
} from './file-ownership-reply-schema'

describe('file ownership reply schemas', () => {
  it('keeps the three hostId states distinct', () => {
    // Missing, null, and explicit execution owners must reach the capture without substitution.
    expect(fileOwnershipWorktreeSchema.parse({ worktree: {} })?.hostId).toBeUndefined()
    expect(fileOwnershipWorktreeSchema.parse({ worktree: { hostId: null } })?.hostId).toBeNull()
    expect(fileOwnershipWorktreeSchema.parse({ worktree: { hostId: 'ssh:a' } })?.hostId).toBe(
      'ssh:a'
    )
  })

  it('refuses a wrong-typed hostId instead of salvaging it to local', () => {
    expect(fileOwnershipWorktreeSchema.safeParse({ worktree: { hostId: 7 } }).success).toBe(false)
  })

  it('keeps an unresolved worktree readable as the absent summary main threw on', () => {
    expect(fileOwnershipWorktreeSchema.parse({})).toBeUndefined()
    expect(fileOwnershipWorktreeSchema.parse({ worktree: null })).toBeNull()
  })

  it('passes the connection generation through and refuses a wrong-typed one', () => {
    // The generation is echoed back to the host on the mutation, so a client-side fallback here
    // would put a value on the wire the host then refuses.
    expect(
      fileOwnershipSshStateSchema.parse({ state: { targetId: 't', connectionGeneration: 3 } })
        ?.connectionGeneration
    ).toBe(3)
    expect(
      fileOwnershipSshStateSchema.safeParse({ state: { targetId: 't', connectionGeneration: '3' } })
        .success
    ).toBe(false)
  })

  it('salvages a wrong-typed targetId onto the mismatch main threw', () => {
    expect(
      fileOwnershipSshStateSchema.parse({ state: { targetId: 7, connectionGeneration: 1 } })
        ?.targetId
    ).toBeUndefined()
  })

  it.each(['connected', 'reconnecting', 'unexpected-status'])(
    'retains SSH status %s so the ownership gate can refuse anything except connected',
    (status) => {
      expect(
        fileOwnershipSshStateSchema.parse({
          state: { targetId: 't', status, connectionGeneration: 3 }
        })?.status
      ).toBe(status)
    }
  )

  it('leaves a missing or unreadable SSH status unverified', () => {
    expect(
      fileOwnershipSshStateSchema.parse({ state: { targetId: 't', connectionGeneration: 3 } })
        ?.status
    ).toBeUndefined()
    expect(
      fileOwnershipSshStateSchema.parse({
        state: { targetId: 't', status: 7, connectionGeneration: 3 }
      })?.status
    ).toBeUndefined()
  })

  it('reads a host holding no connection as the null state it sends', () => {
    expect(fileOwnershipSshStateSchema.parse({ state: null })).toBeNull()
    expect(fileOwnershipSshStateSchema.parse({})).toBeUndefined()
  })
})
