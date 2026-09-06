import { describe, expect, it } from 'vitest'
import {
  appendRetiredTerminalSurfaceProofs,
  preserveTerminalRetirementProofs
} from './mobile-session-terminal-retirement-proof'
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
  it.each([{ worktree: 'another-worktree' }, { worktreeInstanceId: 'successor-instance' }])(
    'does not copy retirement proof into a different workspace: %j',
    (identity) => {
      const next = snapshot(identity)
      expect(
        preserveTerminalRetirementProofs(next, snapshot({ retiredTerminalSurfaces: [retired] }))
      ).toBe(next)
    }
  )

  it('drops an old proof when its surface is published again', () => {
    const existing = snapshot({ retiredTerminalSurfaces: [retired] })
    const revived = preserveTerminalRetirementProofs(
      snapshot({
        tabs: [
          {
            type: 'terminal',
            id: 'tab::leaf',
            parentTabId: 'tab',
            leafId: 'leaf',
            ptyId: 'successor-pty',
            title: 'Successor',
            isActive: false
          }
        ]
      }),
      existing
    )
    expect(revived.retiredTerminalSurfaces).toEqual([])
    expect(
      preserveTerminalRetirementProofs(snapshot(), revived).retiredTerminalSurfaces
    ).toBeUndefined()
  })
  it('keeps the newest 64 exact identities', () => {
    let proofs = appendRetiredTerminalSurfaceProofs(
      undefined,
      Array.from({ length: 64 }, (_, index) => ({
        parentTabId: `tab-${index}`,
        leafId: `leaf-${index}`,
        ptyId: `pty-${index}`,
        terminal: 'term-old',
        incarnationId: 'inc-old'
      }))
    )

    proofs = appendRetiredTerminalSurfaceProofs(proofs, [
      {
        parentTabId: 'tab-new',
        leafId: 'leaf-new',
        ptyId: 'pty-new',
        terminal: 'term-new',
        incarnationId: 'inc-new'
      }
    ])

    expect(proofs).toHaveLength(64)
    expect(proofs[0]?.parentTabId).toBe('tab-1')
    expect(proofs.at(-1)).toEqual({
      parentTabId: 'tab-new',
      leafId: 'leaf-new',
      ptyId: 'pty-new',
      terminal: 'term-new',
      incarnationId: 'inc-new'
    })
  })

  it('preserves each retired leaf identity independently', () => {
    const proofs = appendRetiredTerminalSurfaceProofs(undefined, [
      {
        parentTabId: 'tab-split',
        leafId: 'leaf-left',
        ptyId: 'pty-left',
        terminal: 'term-left',
        incarnationId: 'inc-left'
      },
      {
        parentTabId: 'tab-split',
        leafId: 'leaf-right',
        ptyId: 'pty-right',
        terminal: 'term-right',
        incarnationId: 'inc-right'
      }
    ])

    expect(proofs).toEqual([
      expect.objectContaining({ leafId: 'leaf-left', terminal: 'term-left' }),
      expect.objectContaining({ leafId: 'leaf-right', terminal: 'term-right' })
    ])
  })
})
