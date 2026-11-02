import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { PANE_NOT_LIVE_ERROR } from '../../../../shared/pane-attach-only-view'
import { attachViewAfterHiddenStart, attachViewWithoutOwner } from './attach-only-view'

import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  isHiddenRendererPty,
  isRuntimeOwnedHiddenRendererPty,
  markHiddenRendererPty,
  markRuntimeOwnedHiddenRendererPty,
  recordHiddenRendererPtyDataDrop,
  unmarkHiddenRendererPty
} from '../delivery/pty-hidden-delivery-gate'
import { attachingRendererViewPtys } from '../delivery/visibility-state'
import { attemptStablePaneAttach } from './stable-pane-attach'
import type { StablePaneOwner } from './stable-owner'

const OWNER: StablePaneOwner = {
  tabId: 'tab-1',
  leafId: '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
  ptyId: 'pty-1',
  hasPersistedBinding: true
}

function providerOf(spawn: ReturnType<typeof vi.fn>): IPtyProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a view of a pane calls only provider.spawn.
  return { spawn } as unknown as IPtyProvider
}

describe("a window's attach-only view of a pane main starts", () => {
  it("starts nothing and keeps the binding when the owner's terminal is gone", async () => {
    const spawn = vi.fn().mockRejectedValue(new SessionNotFoundError(OWNER.ptyId))
    const keepAbsentBinding = vi.fn()
    await expect(
      attemptStablePaneAttach({
        runtime: undefined,
        provider: providerOf(spawn),
        spawnOptions: { cols: 80, rows: 24 },
        owner: OWNER,
        resolveOwner: () => OWNER,
        keepAbsentBinding,
        attachOnlyView: true
      })
    ).rejects.toThrow(PANE_NOT_LIVE_ERROR)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(keepAbsentBinding).not.toHaveBeenCalled()
  })

  it('with no recorded owner and no live terminal, starts nothing', async () => {
    const spawn = vi.fn().mockRejectedValue(new SessionNotFoundError('pty-1'))
    await expect(
      attachViewWithoutOwner(providerOf(spawn), { cols: 80, rows: 24, sessionId: 'pty-1' })
    ).rejects.toThrow(PANE_NOT_LIVE_ERROR)
    await expect(attachViewWithoutOwner(providerOf(spawn), { cols: 80, rows: 24 })).rejects.toThrow(
      PANE_NOT_LIVE_ERROR
    )
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe("a view's attach to a pane main started hidden", () => {
  beforeEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
    markRuntimeOwnedHiddenRendererPty('pty-1')
    markHiddenRendererPty('pty-1')
    recordHiddenRendererPtyDataDrop('pty-1', 64)
  })
  const setHidden = (id: string, hidden: boolean): void =>
    hidden ? markHiddenRendererPty(id) : void unmarkHiddenRendererPty(id)
  const revealAsksRestore = (): boolean => unmarkHiddenRendererPty('pty-1').droppedWhileHidden

  it('paints once: its snapshot holds what main dropped, so the reveal asks no second restore', async () => {
    await attachViewAfterHiddenStart('pty-1', setHidden, async () => ({
      id: 'pty-1',
      snapshot: 'x'
    }))
    expect(revealAsksRestore()).toBe(false)
  })

  it('keeps the drops for a restore when the attach carries no snapshot or lands elsewhere', async () => {
    await attachViewAfterHiddenStart('pty-1', setHidden, async () => ({ id: 'pty-1' }))
    expect(revealAsksRestore()).toBe(true)
    await attachViewAfterHiddenStart('pty-1', setHidden, async () => ({
      id: 'pty-2',
      snapshot: 'x'
    }))
    expect(revealAsksRestore()).toBe(true)
  })

  it('keeps a drop made after the view hid again during the attach', async () => {
    await attachViewAfterHiddenStart('pty-1', setHidden, async () => {
      markHiddenRendererPty('pty-1')
      recordHiddenRendererPtyDataDrop('pty-1', 8)
      return { id: 'pty-1', snapshot: 'x' }
    })
    expect(revealAsksRestore()).toBe(true)
  })

  it('keeps main answering for the pane when the attach fails, and keeps its drops', async () => {
    await expect(
      attachViewAfterHiddenStart('pty-1', setHidden, () => Promise.reject(new Error('lost')))
    ).rejects.toThrow('lost')
    expect(isRuntimeOwnedHiddenRendererPty('pty-1')).toBe(true)
    expect(isHiddenRendererPty('pty-1')).toBe(true)
    expect(revealAsksRestore()).toBe(true)
  })

  it('does not hide a terminal it never kept visible when its attach fails', async () => {
    _resetHiddenRendererPtyDeliveryGateForTest()
    await expect(
      attachViewAfterHiddenStart('pty-1', setHidden, () => Promise.reject(new Error('lost')))
    ).rejects.toThrow('lost')
    expect(isHiddenRendererPty('pty-1')).toBe(false)
  })

  it('keeps main from hiding the terminal until the last attaching view finishes', async () => {
    _resetHiddenRendererPtyDeliveryGateForTest()
    let finishFirst!: () => void
    const first = attachViewAfterHiddenStart(
      'pty-1',
      setHidden,
      () => new Promise<{ id: string }>((done) => (finishFirst = () => done({ id: 'pty-1' })))
    )
    let finishSecond!: () => void
    const second = attachViewAfterHiddenStart(
      'pty-1',
      setHidden,
      () => new Promise<{ id: string }>((done) => (finishSecond = () => done({ id: 'pty-1' })))
    )
    finishFirst()
    await first
    expect(attachingRendererViewPtys.has('pty-1')).toBe(true)
    finishSecond()
    await second
    expect(attachingRendererViewPtys.has('pty-1')).toBe(false)
  })
})
