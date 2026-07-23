import { describe, expect, it } from 'vitest'
import {
  getTerminalLiveHardwareKeyboardFocusDecision,
  planExplicitSoftKeyboardFocus,
  shouldAutoSilentFocusLiveInput
} from './terminal-live-hardware-keyboard-focus'

describe('terminal live hardware keyboard focus', () => {
  it('Given live input active without soft request When decided Then silent-focus', () => {
    expect(
      getTerminalLiveHardwareKeyboardFocusDecision({
        wantSoftKeyboard: false,
        liveInputEnabled: true,
        canSend: true
      })
    ).toEqual({ kind: 'silent-focus', showSoftInputOnFocus: false })
  })

  it('Given explicit soft request When decided Then soft-focus', () => {
    expect(
      getTerminalLiveHardwareKeyboardFocusDecision({
        wantSoftKeyboard: true,
        liveInputEnabled: true,
        canSend: true
      })
    ).toEqual({ kind: 'soft-focus', showSoftInputOnFocus: true })
  })

  it('Given modal open When auto-silent checked Then does not steal focus', () => {
    expect(
      shouldAutoSilentFocusLiveInput({
        liveInputEnabled: true,
        canSend: true,
        wantSoftKeyboard: false,
        isFocused: false,
        modalOpen: true
      })
    ).toBe(false)
  })

  it('Given unfocused live terminal When auto-silent checked Then focuses silently', () => {
    expect(
      shouldAutoSilentFocusLiveInput({
        liveInputEnabled: true,
        canSend: true,
        wantSoftKeyboard: false,
        isFocused: false,
        modalOpen: false
      })
    ).toBe(true)
  })

  it('Given initially blurred input When soft latch is false Then defers focus until latch', () => {
    expect(
      planExplicitSoftKeyboardFocus({ alreadyWantsSoftKeyboard: false, isFocused: false })
    ).toEqual({ kind: 'defer-until-latch' })
  })

  it('Given already focused silent field When soft requested Then blur-refocus after latch', () => {
    expect(
      planExplicitSoftKeyboardFocus({ alreadyWantsSoftKeyboard: false, isFocused: true })
    ).toEqual({ kind: 'blur-refocus-after-latch' })
  })

  it('Given soft latch already true and unfocused When soft requested Then focus now', () => {
    expect(
      planExplicitSoftKeyboardFocus({ alreadyWantsSoftKeyboard: true, isFocused: false })
    ).toEqual({ kind: 'focus-now' })
  })

  it('Given soft latch already true and focused When soft requested Then forces a responder cycle', () => {
    expect(
      planExplicitSoftKeyboardFocus({ alreadyWantsSoftKeyboard: true, isFocused: true })
    ).toEqual({ kind: 'blur-refocus-after-latch' })
  })
})
