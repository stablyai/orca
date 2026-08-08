import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)
// Why: the three input-bar branches (hardware-keyboard / live-input / buffered)
// live in this extracted component, not the session route.
const inputBarSource = readFileSync(
  new URL('../session/terminal-session-input-bar.tsx', import.meta.url),
  'utf8'
)
const liveInputStatusSource = readFileSync(
  new URL('../session/MobileTerminalLiveInputStatus.tsx', import.meta.url),
  'utf8'
)
const commandInputStylesSource = readFileSync(
  new URL('../session/mobile-session-command-input-styles.ts', import.meta.url),
  'utf8'
)
const liveInputFocusSource = readFileSync(
  new URL('./use-terminal-live-input-focus.ts', import.meta.url),
  'utf8'
)

function liveInputBarBlock(): string {
  const start = inputBarSource.indexOf('if (liveInputEnabled) {')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = inputBarSource.indexOf('\n  return (\n    <View style={styles.inputBar}>', start)
  expect(end).toBeGreaterThan(start)
  return inputBarSource.slice(start, end)
}

describe('terminal live input affordance', () => {
  it('keeps the live status row wired as the keyboard focus control', () => {
    const block = liveInputBarBlock()

    expect(block).toContain('onPress={focusLiveInput}')
    expect(block).toContain('accessibilityRole="button"')
    expect(block).toContain('accessibilityLabel="Show keyboard for live terminal input"')
    expect(block).toContain(
      'accessibilityHint="Typed text is sent directly to the active terminal"'
    )
    expect(block).toContain('pressed && styles.liveInputFocusTargetPressed')
    expect(block).toContain('!canSend && styles.liveInputFocusTargetDisabled')
    expect(block).toContain('showSoftInputOnFocus')
    expect(block).toContain('liveInputText={liveInputCapture}')
    expect(sessionRouteSource).toContain('useTerminalLiveInputFocus({')
    expect(sessionRouteSource).toContain('return resetLiveInputFocus')
    expect(liveInputFocusSource).toContain('focusTerminalLiveInputTarget(inputRef.current')
    expect(liveInputFocusSource).toContain('lifecycleIdentity,')
    expect(liveInputFocusSource).toContain('resetLiveInputFocus')
    expect(liveInputFocusSource).toContain('keyboardHeight: context.keyboardHeight')
    expect(liveInputFocusSource).toContain(
      'scheduleTerminalLiveInputFocus(timerRef, focusLiveInput)'
    )
  })

  it('makes the live keyboard target visible instead of status-only chrome', () => {
    expect(liveInputStatusSource).toContain("'Tap to show keyboard'")
    expect(liveInputStatusSource).toContain("liveInputText || 'Tap to show keyboard'")
    expect(liveInputStatusSource).toContain('ellipsizeMode="head"')
    expect(commandInputStylesSource).toContain('backgroundColor: colors.bgRaised')
    expect(commandInputStylesSource).toContain('borderWidth: 1')
    expect(commandInputStylesSource).toContain('liveInputFocusTargetPressed')
  })
})
