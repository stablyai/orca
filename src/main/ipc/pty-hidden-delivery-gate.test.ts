import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  clearHiddenRendererPtyDeliveryState,
  getHiddenRendererPtyDeliveryDebug,
  isDaemonQueryResponderConfirmed,
  isHiddenPtyDeliveryGateEnabled,
  isHiddenRendererPtyViewGated,
  markHiddenRendererPty,
  markRuntimeOwnedHiddenRendererPty,
  recordHiddenRendererPtyDataDrop,
  registerHiddenRendererPtyMarkListener,
  registerHiddenRendererPtyUnmarkListener,
  resetRendererScopedHiddenPtyDeliveryState,
  setDaemonQueryResponderConfirmed,
  setHiddenDeliveryDaemonHandoff,
  setHiddenDeliveryModelHandoff,
  setHiddenDeliveryViewGateChangeListener,
  setRendererPtyDeliveryInterest,
  shouldDeliverHiddenRendererPtyDataToSidecarsOnly,
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

  it('keeps the view gated under delivery interest and sends those bytes to sidecars only', () => {
    markHiddenRendererPty(PTY_ID)
    setRendererPtyDeliveryInterest(PTY_ID, true)
    expect(isHiddenRendererPtyViewGated(PTY_ID, {})).toBe(true)
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)
    expect(shouldDeliverHiddenRendererPtyDataToSidecarsOnly(PTY_ID, {})).toBe(true)
    expect(
      shouldDeliverHiddenRendererPtyDataToSidecarsOnly(PTY_ID, {
        terminalHiddenDeliveryGate: false
      })
    ).toBe(false)

    setRendererPtyDeliveryInterest(PTY_ID, false)
    expect(shouldDeliverHiddenRendererPtyDataToSidecarsOnly(PTY_ID, {})).toBe(false)
    unmarkHiddenRendererPty(PTY_ID)
    setRendererPtyDeliveryInterest(PTY_ID, true)
    expect(isHiddenRendererPtyViewGated(PTY_ID, {})).toBe(false)
    expect(shouldDeliverHiddenRendererPtyDataToSidecarsOnly(PTY_ID, {})).toBe(false)
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

  it('keeps runtime-owned marks across reload until unmark or teardown', () => {
    markRuntimeOwnedHiddenRendererPty(PTY_ID)
    markRuntimeOwnedHiddenRendererPty('pty-2')

    resetRendererScopedHiddenPtyDeliveryState()
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(true)

    unmarkHiddenRendererPty(PTY_ID)
    clearHiddenRendererPtyDeliveryState('pty-2')
    resetRendererScopedHiddenPtyDeliveryState()
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)
    expect(shouldDropHiddenRendererPtyData('pty-2', {})).toBe(false)
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
      hiddenDeliveryDroppedChunks: 2,
      daemonQueryResponderPtyCount: 0
    })

    clearHiddenRendererPtyDeliveryState(PTY_ID)
    clearHiddenRendererPtyDeliveryState('pty-2')
    expect(getHiddenRendererPtyDeliveryDebug()).toMatchObject({
      hiddenDeliveryGatedPtyCount: 0,
      deliveryInterestPtyCount: 0
    })
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)
  })

  it('keeps feeding a hidden PTY while its main model hands off, opened from the mark itself', () => {
    const changes: string[] = []
    setHiddenDeliveryViewGateChangeListener((id) => changes.push(id))
    registerHiddenRendererPtyMarkListener((id) => setHiddenDeliveryModelHandoff(id, true))

    markHiddenRendererPty(PTY_ID)
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)
    markRuntimeOwnedHiddenRendererPty('pty-2')
    expect(shouldDropHiddenRendererPtyData('pty-2', {})).toBe(false)

    setHiddenDeliveryModelHandoff(PTY_ID, false)
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(true)
    setHiddenDeliveryModelHandoff(PTY_ID, false)
    expect(changes).toEqual([PTY_ID, 'pty-2', PTY_ID])

    clearHiddenRendererPtyDeliveryState('pty-2')
    markHiddenRendererPty('pty-2')
    setHiddenDeliveryModelHandoff('pty-2', false)
    expect(shouldDropHiddenRendererPtyData('pty-2', {})).toBe(true)
  })

  it('keeps a sidecar-interest PTY fully delivered to its view during a model handoff', () => {
    registerHiddenRendererPtyMarkListener((id) => setHiddenDeliveryModelHandoff(id, true))
    setRendererPtyDeliveryInterest(PTY_ID, true)
    markHiddenRendererPty(PTY_ID)

    // Why: the view answers this PTY's queries until main's model catches up, so main must not.
    expect(isHiddenRendererPtyViewGated(PTY_ID, {})).toBe(false)
    expect(shouldDeliverHiddenRendererPtyDataToSidecarsOnly(PTY_ID, {})).toBe(false)
    setHiddenDeliveryModelHandoff(PTY_ID, false)
    expect(isHiddenRendererPtyViewGated(PTY_ID, {})).toBe(true)
    expect(shouldDeliverHiddenRendererPtyDataToSidecarsOnly(PTY_ID, {})).toBe(true)
  })

  it('keeps the view answering a hidden PTY until the daemon confirms it answers', () => {
    const changes: string[] = []
    setHiddenDeliveryViewGateChangeListener((id) => changes.push(id))
    registerHiddenRendererPtyMarkListener((id) => setHiddenDeliveryDaemonHandoff(id, true))
    markHiddenRendererPty(PTY_ID)
    expect(isHiddenRendererPtyViewGated(PTY_ID, {})).toBe(false)

    setDaemonQueryResponderConfirmed(PTY_ID, true)
    expect(isDaemonQueryResponderConfirmed(PTY_ID)).toBe(true)
    expect(isHiddenRendererPtyViewGated(PTY_ID, {})).toBe(true)
    expect(changes).toEqual([PTY_ID, PTY_ID])
  })

  it('gates a revealed view until the daemon lets go, then asks for the deferred restore', () => {
    const unmarked: string[] = []
    registerHiddenRendererPtyUnmarkListener((id) => {
      unmarked.push(id)
      setHiddenDeliveryDaemonHandoff(id, false)
    })
    markHiddenRendererPty(PTY_ID)
    setHiddenDeliveryDaemonHandoff(PTY_ID, true)
    setDaemonQueryResponderConfirmed(PTY_ID, true)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 4).shouldEmitRestoreMarker).toBe(true)

    expect(unmarkHiddenRendererPty(PTY_ID)).toEqual({ droppedWhileHidden: false })
    expect(unmarked).toEqual([PTY_ID])
    // Why: the daemon still answers these bytes, so the view must not parse them.
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(true)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 4).shouldEmitRestoreMarker).toBe(false)

    expect(setDaemonQueryResponderConfirmed(PTY_ID, false)).toEqual({ droppedWhileHidden: true })
    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)
    expect(setDaemonQueryResponderConfirmed(PTY_ID, false)).toEqual({ droppedWhileHidden: false })
  })

  it('defers a first drop after reveal to the take-back marker', () => {
    markHiddenRendererPty(PTY_ID)
    setDaemonQueryResponderConfirmed(PTY_ID, true)
    unmarkHiddenRendererPty(PTY_ID)

    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 4).shouldEmitRestoreMarker).toBe(false)
    expect(setDaemonQueryResponderConfirmed(PTY_ID, false)).toEqual({ droppedWhileHidden: true })
  })

  it('gates on a daemon confirmation even with the gate switched off, and clears on teardown', () => {
    setDaemonQueryResponderConfirmed(PTY_ID, true)
    expect(isHiddenRendererPtyViewGated(PTY_ID, { terminalHiddenDeliveryGate: false })).toBe(true)

    clearHiddenRendererPtyDeliveryState(PTY_ID)
    expect(isDaemonQueryResponderConfirmed(PTY_ID)).toBe(false)
    expect(isHiddenRendererPtyViewGated(PTY_ID, {})).toBe(false)
  })
})
