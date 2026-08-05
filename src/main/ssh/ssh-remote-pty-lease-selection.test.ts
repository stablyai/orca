import { describe, expect, it } from 'vitest'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import {
  coalesceSshRemotePtyLeasesByIdentity,
  selectSshRemotePtyLeasesForReattach
} from './ssh-remote-pty-lease-selection'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function lease(overrides: Partial<SshRemotePtyLease> = {}): SshRemotePtyLease {
  return {
    targetId: 'target-1',
    ptyId: 'pty-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: LEAF_ID,
    state: 'detached',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('SSH remote PTY lease selection', () => {
  it('prefers the durable pane binding over a newer unbound lease', () => {
    const bound = lease({ ptyId: 'pty-bound', createdAt: 1, updatedAt: 1 })
    const newer = lease({ ptyId: 'pty-newer', createdAt: 2, updatedAt: 2 })

    expect(
      selectSshRemotePtyLeasesForReattach([bound, newer], {
        isDurablyBound: (candidate) => candidate === bound
      })
    ).toEqual({ candidates: [bound], discardedDuplicates: [newer] })
  })

  it('lets a newer final lease tombstone an older active pane lease', () => {
    const active = lease({ ptyId: 'pty-old', createdAt: 1, updatedAt: 1 })
    const terminated = lease({
      ptyId: 'pty-new',
      state: 'terminated',
      createdAt: 2,
      updatedAt: 2
    })

    expect(selectSshRemotePtyLeasesForReattach([active, terminated])).toEqual({
      candidates: [],
      discardedDuplicates: [active]
    })
    expect(
      selectSshRemotePtyLeasesForReattach([active, terminated], {
        isDurablyBound: (candidate) => candidate === active
      })
    ).toEqual({ candidates: [], discardedDuplicates: [active] })
  })

  it('coalesces duplicate remote PTY identities without quarantining the winner', () => {
    const older = lease({ state: 'expired', createdAt: 1, updatedAt: 1 })
    const newer = lease({ state: 'attached', createdAt: 2, updatedAt: 2 })

    expect(coalesceSshRemotePtyLeasesByIdentity([older, newer])).toEqual([newer])
    expect(selectSshRemotePtyLeasesForReattach([older, newer])).toEqual({
      candidates: [newer],
      discardedDuplicates: []
    })
  })
})
