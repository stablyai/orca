import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  clearHiddenRendererPtyDeliveryState,
  consumeHiddenRendererPtyDropMemory,
  getHiddenRendererPtyDeliveryDebug,
  isHiddenPtyDeliveryGateEnabled,
  markHiddenRendererPty,
  markRuntimeOwnedHiddenRendererPty,
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

  it('requests the restore marker exactly once per drop episode, re-armed by the applied ack', () => {
    markHiddenRendererPty(PTY_ID)
    const drop = recordHiddenRendererPtyDataDrop(PTY_ID, 10)
    expect(drop.shouldEmitRestoreMarker).toBe(true)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(false)

    // An ack before any reveal belongs to an earlier restore and retires nothing.
    consumeHiddenRendererPtyDropMemory(PTY_ID, drop.hiddenDropEpisode)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(false)

    unmarkHiddenRendererPty(PTY_ID)
    consumeHiddenRendererPtyDropMemory(PTY_ID, drop.hiddenDropEpisode)
    markHiddenRendererPty(PTY_ID)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(true)
  })

  it('keeps drop memory across unhide until the renderer acks the paint (STA-4869)', () => {
    markHiddenRendererPty(PTY_ID)
    const { hiddenDropEpisode } = recordHiddenRendererPtyDataDrop(PTY_ID, 10)

    // A retiring pane may unhide after unregistering its handler; later reveals must still request restore.
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(true)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(true)

    // An ack that names no episode cannot prove what it covered.
    consumeHiddenRendererPtyDropMemory(PTY_ID)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(true)

    consumeHiddenRendererPtyDropMemory(PTY_ID, hiddenDropEpisode)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(false)
  })

  it('a drop after the reveal survives the in-flight restore ack and re-emits its marker', () => {
    markHiddenRendererPty(PTY_ID)
    const first = recordHiddenRendererPtyDataDrop(PTY_ID, 10).hiddenDropEpisode
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(true)

    // The user switches away again before the reveal's snapshot is painted.
    markHiddenRendererPty(PTY_ID)
    const second = recordHiddenRendererPtyDataDrop(PTY_ID, 10)
    expect(second.shouldEmitRestoreMarker).toBe(true)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(false)
    // That snapshot may predate the new drop, so its ack must not retire the latch.
    consumeHiddenRendererPtyDropMemory(PTY_ID, first)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(true)
    consumeHiddenRendererPtyDropMemory(PTY_ID, first)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(true)

    consumeHiddenRendererPtyDropMemory(PTY_ID, second.hiddenDropEpisode)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(false)
  })

  it('tags every marker of one drop episode with the same episode id', () => {
    markHiddenRendererPty(PTY_ID)
    const first = recordHiddenRendererPtyDataDrop(PTY_ID, 10).hiddenDropEpisode
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).hiddenDropEpisode).toBe(first)
    expect(unmarkHiddenRendererPty(PTY_ID).hiddenDropEpisode).toBe(first)
    expect(unmarkHiddenRendererPty(PTY_ID).hiddenDropEpisode).toBe(first)

    markHiddenRendererPty(PTY_ID)
    const second = recordHiddenRendererPtyDataDrop(PTY_ID, 10).hiddenDropEpisode
    expect(second).not.toBe(first)
    expect(unmarkHiddenRendererPty(PTY_ID).hiddenDropEpisode).toBe(second)
  })

  it('retires drop memory on teardown', () => {
    markHiddenRendererPty(PTY_ID)
    recordHiddenRendererPtyDataDrop(PTY_ID, 10)

    clearHiddenRendererPtyDeliveryState(PTY_ID)
    markHiddenRendererPty(PTY_ID)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(false)
  })

  it('consuming drop memory it never had is a no-op for other PTYs', () => {
    markHiddenRendererPty(PTY_ID)
    recordHiddenRendererPtyDataDrop(PTY_ID, 10)

    consumeHiddenRendererPtyDropMemory('pty-2', 1)
    expect(unmarkHiddenRendererPty(PTY_ID).droppedWhileHidden).toBe(true)
  })

  it('keeps drop memory when an already-dropped PTY is re-marked hidden', () => {
    // Hidden remounts and reloads re-mark without revealing; preserve the unrestored gap.
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

    expect(shouldDropHiddenRendererPtyData(PTY_ID, {})).toBe(false)
    expect(getHiddenRendererPtyDeliveryDebug()).toMatchObject({
      hiddenDeliveryGatedPtyCount: 0,
      deliveryInterestPtyCount: 0
    })
    markHiddenRendererPty('pty-2')
    expect(shouldDropHiddenRendererPtyData('pty-2', {})).toBe(true)
    // Preserve drop memory so the replacement renderer can still request restore.
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
