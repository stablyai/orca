import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { readMobileSessionRouteSource } from '../session/mobile-session-route-source-family.test-support'

const commandDockSource = readMobileSessionRouteSource('../session/MobileSessionCommandDock.tsx')
const terminalRuntimeSource = readMobileSessionRouteSource(
  '../session/use-mobile-session-terminal-runtime.ts'
)
const nativeChatSource = readMobileSessionRouteSource(
  '../session/use-mobile-session-native-chat-dictation.ts'
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
const sendCompletionGenerationSource = readFileSync(
  new URL('../session/use-mobile-send-completion-generation.ts', import.meta.url),
  'utf8'
)

function liveInputBarBlock(): string {
  const start = commandDockSource.indexOf('{liveInputEnabled ? (')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = commandDockSource.indexOf(') : (', start)
  expect(end).toBeGreaterThan(start)
  return commandDockSource.slice(start, end)
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
    expect(terminalRuntimeSource).toContain('useTerminalLiveInputFocus({')
    expect(nativeChatSource).toContain('useMobileSendCompletionGeneration({')
    expect(nativeChatSource).toContain('onBlur: resetLiveInputFocus')
    expect(sendCompletionGenerationSource).toContain('return () => {')
    expect(sendCompletionGenerationSource).toContain('onBlur()')
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
