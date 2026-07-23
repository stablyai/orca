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
const liveInputBarSource = readFileSync(
  new URL('../session/MobileTerminalLiveInputBar.tsx', import.meta.url),
  'utf8'
)
const hardwareKeyboardHookSource = readFileSync(
  new URL('./use-terminal-live-hardware-keyboard.ts', import.meta.url),
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

    expect(block).toContain('<MobileTerminalLiveInputBar')
    expect(block).toContain('onFocusPress={focusLiveInput}')
    expect(block).toContain('showSoftInputOnFocus={showSoftInputOnFocus}')
    expect(liveInputBarSource).toContain('accessibilityRole="button"')
    expect(liveInputBarSource).toContain(
      'accessibilityLabel="Show keyboard for live terminal input"'
    )
    expect(liveInputBarSource).toContain(
      'accessibilityHint="Typed text is sent directly to the active terminal"'
    )
    expect(liveInputBarSource).toContain('pressed && styles.liveInputFocusTargetPressed')
    expect(liveInputBarSource).toContain('!canSend && styles.liveInputFocusTargetDisabled')
    expect(sessionRouteSource).toContain('requestSoftKeyboardFocus()')
    expect(hardwareKeyboardHookSource).toContain(
      'scheduleTerminalLiveInputFocus(liveInputFocusTimerRef'
    )
  })

  it('makes the live keyboard target visible instead of status-only chrome', () => {
    expect(liveInputStatusSource).toContain("'Tap to show keyboard'")
    expect(commandInputStylesSource).toContain('backgroundColor: colors.bgRaised')
    expect(commandInputStylesSource).toContain('borderWidth: 1')
    expect(commandInputStylesSource).toContain('liveInputFocusTargetPressed')
  })
})
