import { afterEach, describe, expect, it, vi } from 'vitest'
import { HoldQuitGesture, type HoldQuitWatchEvent } from './hold-quit-gesture'

function fixture() {
  let enabled = true
  let busy = true
  let focused = true
  let recording = false
  const quit = vi.fn()
  const notice = vi.fn()
  const watches: { emit: (event: HoldQuitWatchEvent) => void; cancel: ReturnType<typeof vi.fn> }[] =
    []
  const isEnabled = vi.fn(() => enabled)
  const isBusy = vi.fn(() => busy)
  const isFocused = vi.fn(() => focused)
  const isRecording = vi.fn(() => recording)
  const gesture = new HoldQuitGesture({
    isEnabled,
    isBusy,
    isFocused,
    isRecording,
    quit,
    notice,
    watch: (_code, emit) => {
      const cancel = vi.fn()
      watches.push({ emit, cancel })
      return cancel
    }
  })
  const down = (repeat = false) =>
    gesture.input({ type: 'keyDown', code: 'KeyQ', key: 'q', meta: true, isAutoRepeat: repeat })
  return {
    gesture,
    down,
    quit,
    notice,
    watches,
    isEnabled,
    isBusy,
    isFocused,
    isRecording,
    setEnabled: (value: boolean) => {
      enabled = value
      gesture.refresh()
    },
    setBusy: (value: boolean) => {
      busy = value
      gesture.refresh()
    },
    setFocused: (value: boolean) => {
      focused = value
    },
    setRecording: (value: boolean) => {
      recording = value
    }
  }
}

afterEach(() => vi.useRealTimers())

describe('keyboard-only hold quit gesture', () => {
  it('does not consult gesture dependencies for ordinary key presses or releases', () => {
    const f = fixture()
    for (const type of ['keyDown', 'keyUp']) {
      f.gesture.input({ type, key: 'a', code: 'KeyA', meta: false })
      f.gesture.input({ type, key: 'q', code: 'KeyQ', meta: false })
      f.gesture.input({ type, key: 'q', code: 'KeyQ', meta: true, shift: true })
    }
    expect({
      enabled: f.isEnabled.mock.calls.length,
      busy: f.isBusy.mock.calls.length,
      focused: f.isFocused.mock.calls.length,
      recording: f.isRecording.mock.calls.length
    }).toEqual({ enabled: 0, busy: 0, focused: 0, recording: 0 })
    expect(f.watches).toHaveLength(0)
    expect(f.quit).not.toHaveBeenCalled()
    expect(f.notice).not.toHaveBeenCalled()
  })

  it('leaves disabled shortcuts to the native menu and immediately quits on a fresh idle tap', () => {
    const f = fixture()
    f.setEnabled(false)
    f.down()
    expect(f.quit).not.toHaveBeenCalled()
    expect(f.watches).toHaveLength(0)
    f.setEnabled(true)
    f.setBusy(false)
    f.down()
    expect(f.quit).toHaveBeenCalledOnce()
    expect(f.watches).toHaveLength(0)
  })

  it('explains actual work immediately and quits only on a native completed hold, once', () => {
    const f = fixture()
    f.down()
    expect(f.notice).toHaveBeenLastCalledWith({ phase: 'starting' })
    expect(f.quit).not.toHaveBeenCalled()
    f.watches[0]?.emit('watching')
    expect(f.notice).toHaveBeenLastCalledWith({ phase: 'holding' })
    f.watches[0]?.emit('held')
    f.watches[0]?.emit('held')
    f.down(true)
    expect(f.quit).toHaveBeenCalledOnce()
    expect(f.watches).toHaveLength(1)
  })

  it.each([
    { type: 'keyUp', key: 'q', code: 'KeyQ', meta: true },
    { type: 'keyUp', key: 'Meta', code: 'MetaLeft', meta: false },
    { type: 'keyUp', key: 'Meta', code: 'MetaRight', meta: false }
  ])('cancels on release while keeping the explanation readable: $code', (release) => {
    vi.useFakeTimers()
    const f = fixture()
    f.down()
    f.watches[0]?.emit('watching')
    f.gesture.input(release)
    expect(f.watches[0]?.cancel).toHaveBeenCalledOnce()
    expect(f.notice).toHaveBeenLastCalledWith({ phase: 'released' })
    f.watches[0]?.emit('held')
    vi.advanceTimersByTime(1999)
    expect(f.notice).toHaveBeenLastCalledWith({ phase: 'released' })
    expect(f.quit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(f.notice).toHaveBeenLastCalledWith({ phase: 'dismissed' })
  })

  it.each(['cancel', 'disable', 'blur', 'destroy', 'recorder'])(
    'rejects completion after %s, including a late child event',
    (reason) => {
      const f = fixture()
      f.down()
      if (reason === 'disable') {
        f.setEnabled(false)
      } else if (reason === 'recorder') {
        f.setRecording(true)
        f.gesture.refresh()
      } else {
        f.setFocused(false)
        f.gesture.cancel()
      }
      f.watches[0]?.emit('held')
      expect(f.watches[0]?.cancel).toHaveBeenCalledOnce()
      expect(f.quit).not.toHaveBeenCalled()
    }
  )

  it('does not restart on repeat and starts a new generation for a genuine new press', () => {
    const f = fixture()
    f.down()
    f.down(true)
    expect(f.watches).toHaveLength(1)
    f.down()
    expect(f.watches[0]?.cancel).toHaveBeenCalledOnce()
    expect(f.watches).toHaveLength(2)
    f.watches[0]?.emit('held')
    expect(f.quit).not.toHaveBeenCalled()
    f.watches[1]?.emit('held')
    expect(f.quit).toHaveBeenCalledOnce()
  })

  it('does not quit after a released tap when work finishes; a fresh idle tap quits', () => {
    const f = fixture()
    f.down()
    f.watches[0]?.emit('released')
    f.setBusy(false)
    expect(f.notice).toHaveBeenLastCalledWith({ phase: 'dismissed' })
    f.watches[0]?.emit('held')
    f.down(true)
    expect(f.quit).not.toHaveBeenCalled()
    f.down()
    expect(f.quit).toHaveBeenCalledOnce()
  })

  it('allows the genuine held chord to finish after work settles', () => {
    const f = fixture()
    f.down()
    f.setBusy(false)
    f.watches[0]?.emit('held')
    expect(f.quit).toHaveBeenCalledOnce()
  })

  it('shows a usable failure notice when the native helper is unavailable', () => {
    const f = fixture()
    f.down()
    f.watches[0]?.emit('unavailable')
    expect(f.notice).toHaveBeenLastCalledWith({ phase: 'unavailable' })
    f.watches[0]?.emit('held')
    expect(f.quit).not.toHaveBeenCalled()
  })

  it('leaves recorder-owned and extra-modifier chords alone', () => {
    const f = fixture()
    f.setRecording(true)
    f.down()
    f.setRecording(false)
    f.gesture.input({ type: 'keyDown', key: 'q', code: 'KeyQ', meta: true, shift: true })
    expect(f.watches).toHaveLength(0)
    expect(f.quit).not.toHaveBeenCalled()
  })

  it('uses the actual logical-Q physical key and cancels its release on AZERTY', () => {
    const f = fixture()
    f.gesture.input({ type: 'keyDown', key: 'a', code: 'KeyQ', meta: true })
    expect(f.watches).toHaveLength(0)
    f.gesture.input({ type: 'keyDown', key: 'q', code: 'KeyA', meta: true })
    expect(f.watches).toHaveLength(1)
    f.gesture.input({ type: 'keyUp', key: 'Q', code: 'KeyA', meta: true })
    f.watches[0]?.emit('held')
    expect(f.quit).not.toHaveBeenCalled()
  })
})
