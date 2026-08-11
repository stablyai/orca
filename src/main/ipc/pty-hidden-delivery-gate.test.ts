import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  clearHiddenRendererPtyDeliveryState,
  getHiddenRendererPtyDeliveryDebug,
  isHiddenPtyDeliveryGateEnabled,
  markHiddenRendererPty,
  recordHiddenRendererPtyDataDrop,
  resetRendererScopedHiddenPtyDeliveryState,
  setRendererPtyDeliveryInterest,
  shouldDropHiddenRendererPtyData,
  unmarkHiddenRendererPty
} from './pty-hidden-delivery-gate'

const PTY_ID = 'pty-1'

describe('pty hidden delivery gate', () => {
  beforeEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  it('only operates when both kill switches are on (default on)', () => {
    expect(isHiddenPtyDeliveryGateEnabled(undefined)).toBe(true)
    expect(isHiddenPtyDeliveryGateEnabled({})).toBe(true)
    expect(isHiddenPtyDeliveryGateEnabled({ terminalHiddenDeliveryGate: false })).toBe(false)
    expect(isHiddenPtyDeliveryGateEnabled({ terminalMainSideEffectAuthority: false })).toBe(false)
  })

  it('drops only hidden PTYs without registered delivery interest', () => {
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)

    markHiddenRendererPty(PTY_ID)
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(true)
    expect(shouldDropHiddenRendererPtyData(PTY_ID, { terminalHiddenDeliveryGate: false })).toBe(
      false
    )

    setRendererPtyDeliveryInterest(PTY_ID, true)
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)
    setRendererPtyDeliveryInterest(PTY_ID, false)
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(true)
  })

  it('requests the restore marker exactly once per drop episode, re-armed by unmark', () => {
    markHiddenRendererPty(PTY_ID)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(true)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(false)

    // Why: unmark consumes the latch (and re-emits via its own return value);
    // the next hidden period's first drop reports again.
    unmarkHiddenRendererPty(PTY_ID)
    markHiddenRendererPty(PTY_ID)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(true)
  })

  it('keeps drop memory when an already-dropped PTY is re-marked hidden', () => {
    // Why: a hidden remount or renderer reload re-marks without an unhide in
    // between — clearing the latch there would make reveal skip the restore.
    markHiddenRendererPty(PTY_ID)
    recordHiddenRendererPtyDataDrop(PTY_ID, 10)
    markHiddenRendererPty(PTY_ID)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(true)
  })

  it('reports drops on unhide so reveal can heal a replaced renderer view', () => {
    markHiddenRendererPty(PTY_ID)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(false)

    markHiddenRendererPty(PTY_ID)
    recordHiddenRendererPtyDataDrop(PTY_ID, 10)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(true)
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)
  })

  it('clears renderer-scoped state on reload while preserving drop memory', () => {
    markHiddenRendererPty(PTY_ID)
    recordHiddenRendererPtyDataDrop(PTY_ID, 10)
    setRendererPtyDeliveryInterest('pty-2', true)
    markHiddenRendererPty('pty-2')

    resetRendererScopedHiddenPtyDeliveryState()

    // Hidden marks and interest holds died with the old renderer process.
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)
    expect(getHiddenRendererPtyDeliveryDebug()).toMatchObject({
      hiddenDeliveryGatedPtyCount: 0,
      deliveryInterestPtyCount: 0
    })
    // pty-2's leaked interest is gone: re-marking gates it again.
    markHiddenRendererPty('pty-2')
    expect(shouldDropHiddenRendererPtyData('pty-2', {})).toBe(true)
    // Drop memory survives so the new renderer's first unhide still restores.
    markHiddenRendererPty(PTY_ID)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(true)
  })

  it('clears all per-PTY state on teardown and tracks debug counters', () => {
    markHiddenRendererPty(PTY_ID)
    setRendererPtyDeliveryInterest('pty-2', true)
    recordHiddenRendererPtyDataDrop(PTY_ID, 7)
    recordHiddenRendererPtyDataDrop(PTY_ID, 5)

    expect(getHiddenRendererPtyDeliveryDebug()).toEqual({
      hiddenDeliveryGatedPtyCount: 1,
      deliveryInterestPtyCount: 1,
      hiddenDeliveryDroppedChars: 12,
      hiddenDeliveryDroppedChunks: 2
    })

    clearHiddenRendererPtyDeliveryState(PTY_ID)
    clearHiddenRendererPtyDeliveryState('pty-2')
    expect(getHiddenRendererPtyDeliveryDebug()).toMatchObject({
      hiddenDeliveryGatedPtyCount: 0,
      deliveryInterestPtyCount: 0
    })
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)
  })
})
