import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const liveInputStatusSource = readFileSync(
  new URL('../session/MobileTerminalLiveInputStatus.tsx', import.meta.url),
  'utf8'
)
const commandInputStylesSource = readFileSync(
  new URL('../../app/h/[hostId]/session/mobile-session-command-input-styles.ts', import.meta.url),
  'utf8'
)

function liveInputBarBlock(): string {
  const start = sessionRouteSource.indexOf('{liveInputEnabled ? (')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = sessionRouteSource.indexOf(') : (', start)
  expect(end).toBeGreaterThan(start)
  return sessionRouteSource.slice(start, end)
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
    expect(sessionRouteSource).toContain('focusTerminalLiveInputTarget(liveInputRef.current')
    expect(sessionRouteSource).toContain('keyboardHeight')
    expect(sessionRouteSource).toContain('scheduleTerminalLiveInputFocus(liveInputFocusTimerRef')
  })

  it('makes the live keyboard target visible instead of status-only chrome', () => {
    expect(liveInputStatusSource).toContain("'Tap to show keyboard'")
    expect(commandInputStylesSource).toContain('backgroundColor: colors.bgRaised')
    expect(commandInputStylesSource).toContain('borderWidth: 1')
    expect(commandInputStylesSource).toContain('liveInputFocusTargetPressed')
  })
})
