import { describe, expect, it } from 'vitest'
import { appendRetiredTerminalSurfaceProofs } from './mobile-session-terminal-retirement-proof'

describe('mobile session terminal retirement proofs', () => {
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
