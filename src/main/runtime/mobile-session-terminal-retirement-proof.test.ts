import { describe, expect, it } from 'vitest'
import { preserveTerminalRetirementProofs } from './mobile-session-terminal-retirement-proof'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

const retired = {
  parentTabId: 'tab',
  leafId: 'leaf',
  ptyId: 'pty',
  terminal: 'term',
  incarnationId: 'inc'
}
function snapshot(
  overrides: Partial<RuntimeMobileSessionTabsSnapshot> = {}
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'worktree',
    worktreeInstanceId: 'instance',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    ...overrides
  }
}

describe('mobile session terminal retirement proofs', () => {
  // Identity-less host writes must inherit the occupant, preventing renderer(A) -> host -> renderer(B) proof laundering.
  it('does not launder proofs across occupants through an identity-less host write', () => {
    const occupantA = snapshot({
      worktreeInstanceId: 'instance-a',
      retiredTerminalSurfaces: [retired]
    })
    const hostWrite = preserveTerminalRetirementProofs(
      snapshot({ worktreeInstanceId: undefined, snapshotVersion: 2 }),
      occupantA
    )
    expect(hostWrite.worktreeInstanceId).toBe('instance-a')
    expect(hostWrite.retiredTerminalSurfaces).toEqual([retired])

    const occupantB = snapshot({ worktreeInstanceId: 'instance-b', snapshotVersion: 3 })
    expect(preserveTerminalRetirementProofs(occupantB, hostWrite)).toBe(occupantB)
  })
})
