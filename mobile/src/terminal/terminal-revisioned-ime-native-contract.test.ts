import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const iosView = readFileSync(
  new URL(
    '../../packages/expo-terminal-live-input/ios/TerminalLiveInputView.swift',
    import.meta.url
  ),
  'utf8'
)
const androidView = readFileSync(
  new URL(
    '../../packages/expo-terminal-live-input/android/src/main/java/expo/modules/terminalliveinput/TerminalLiveInputView.kt',
    import.meta.url
  ),
  'utf8'
)
const moduleConfig = readFileSync(
  new URL('../../packages/expo-terminal-live-input/expo-module.config.json', import.meta.url),
  'utf8'
)

describe('revisioned native terminal editor contract', () => {
  it('publishes revisioned iOS snapshots with native marked ranges and no timer window', () => {
    expect(iosView).toContain('revision += 1')
    expect(iosView).toContain('markedTextRange')
    expect(iosView).toContain('"composingStart"')
    expect(iosView).toContain('DispatchQueue.main.async')
    expect(iosView).not.toContain('asyncAfter')
  })

  it('publishes revisioned Android snapshots from composing spans and no timer window', () => {
    expect(androidView).toContain('revision += 1')
    expect(androidView).toContain('BaseInputConnection.getComposingSpanStart')
    expect(androidView).toContain('"composingStart"')
    expect(androidView).toContain('editText.post {')
    expect(androidView).not.toContain('postDelayed')
  })

  it('registers the native module through current Expo platform keys', () => {
    expect(JSON.parse(moduleConfig)).toMatchObject({
      platforms: ['ios', 'android'],
      apple: { modules: ['ExpoTerminalLiveInputModule'] },
      android: {
        modules: ['expo.modules.terminalliveinput.ExpoTerminalLiveInputModule']
      }
    })
  })
})
