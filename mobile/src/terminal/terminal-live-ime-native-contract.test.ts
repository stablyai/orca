import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  const sourceUrl = new URL(relativePath, import.meta.url)
  return existsSync(sourceUrl) ? readFileSync(sourceUrl, 'utf8') : ''
}

const iosSource = readSource(
  '../../packages/expo-terminal-live-input/ios/TerminalLiveInputView.swift'
)
const iosModuleSource = readSource(
  '../../packages/expo-terminal-live-input/ios/ExpoTerminalLiveInputModule.swift'
)
const androidSource = readSource(
  '../../packages/expo-terminal-live-input/android/src/main/java/expo/modules/terminalliveinput/TerminalLiveInputView.kt'
)
const androidModuleSource = readSource(
  '../../packages/expo-terminal-live-input/android/src/main/java/expo/modules/terminalliveinput/ExpoTerminalLiveInputModule.kt'
)
const nativeWrapperSource = readSource(
  '../../packages/expo-terminal-live-input/src/TerminalLiveInputView.tsx'
)
const sessionRouteSource = readSource('../../app/h/[hostId]/session/[worktreeId].tsx')

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('terminal live IME native contract', () => {
  it('defers iOS marked text and emits only after multistage input commits', () => {
    const editingChange = sourceBlock(
      iosSource,
      '@objc private func handleEditingChanged()',
      'private func emitCommittedSnapshotIfNeeded()'
    )
    const markedGuard = editingChange.indexOf('textField.markedTextRange != nil')
    const committedEmit = editingChange.indexOf('emitCommittedSnapshotIfNeeded()')
    expect(markedGuard).toBeGreaterThanOrEqual(0)
    expect(committedEmit).toBeGreaterThan(markedGuard)
    expect(editingChange.slice(markedGuard, committedEmit)).toContain('return')
  })

  it('separates Android composing updates from committed text', () => {
    const composingText = sourceBlock(
      androidSource,
      'override fun setComposingText',
      'override fun setComposingRegion'
    )
    const committedText = sourceBlock(
      androidSource,
      'override fun commitText',
      'override fun finishComposingText'
    )
    const finishedComposition = sourceBlock(
      androidSource,
      'override fun finishComposingText',
      'override fun deleteSurroundingText'
    )
    expect(composingText).not.toContain('emitCommittedSnapshotIfNeeded')
    expect(committedText).toContain('emitCommittedSnapshotIfNeeded')
    expect(finishedComposition).toContain('emitCommittedSnapshotIfNeeded')
  })

  it('keeps IME confirmation separate from terminal Enter on both platforms', () => {
    const iosReturn = sourceBlock(iosSource, 'public func textFieldShouldReturn', '\n  }\n}')
    const androidEnter = sourceBlock(
      androidSource,
      'private fun handleTerminalEnter()',
      'private fun emitCommittedSnapshotIfNeeded()'
    )
    const iosEnterEmit = iosReturn.indexOf('onTerminalEnter')
    const androidEnterEmit = androidEnter.indexOf('onTerminalEnter')
    expect(iosEnterEmit).toBeGreaterThanOrEqual(0)
    expect(androidEnterEmit).toBeGreaterThanOrEqual(0)
    expect(iosReturn.indexOf('textField.markedTextRange')).toBeGreaterThanOrEqual(0)
    expect(iosReturn.indexOf('suppressTerminalEnter')).toBeGreaterThanOrEqual(0)
    expect(androidEnter.indexOf('isComposing')).toBeGreaterThanOrEqual(0)
    expect(androidEnter.indexOf('suppressTerminalEnter')).toBeGreaterThanOrEqual(0)
    expect(iosReturn.indexOf('textField.markedTextRange')).toBeLessThan(iosEnterEmit)
    expect(iosReturn.indexOf('suppressTerminalEnter')).toBeLessThan(iosEnterEmit)
    expect(androidEnter.indexOf('isComposing')).toBeLessThan(androidEnterEmit)
    expect(androidEnter.indexOf('suppressTerminalEnter')).toBeLessThan(androidEnterEmit)
    expect(androidSource).toContain('actionId == EditorInfo.IME_ACTION_NONE')
  })

  it('deduplicates Android key and editor-action callbacks for one terminal Enter', () => {
    const androidEnter = sourceBlock(
      androidSource,
      'private fun handleTerminalEnter()',
      'private fun emitCommittedSnapshotIfNeeded()'
    )
    const duplicateGuard = androidEnter.indexOf('terminalEnterDispatchPending')
    const terminalEnterEmit = androidEnter.indexOf('onTerminalEnter')
    expect(duplicateGuard).toBeGreaterThanOrEqual(0)
    expect(terminalEnterEmit).toBeGreaterThan(duplicateGuard)
  })

  it('reports empty-field Backspace even when no text-change callback can fire', () => {
    expect(iosSource).toContain('override func deleteBackward()')
    expect(androidSource).toContain('override fun deleteSurroundingText')
    expect(androidSource).toContain('override fun deleteSurroundingTextInCodePoints')
    expect(iosSource).toContain('"key": "Backspace"')
    expect(androidSource).toContain('"key" to "Backspace"')
  })

  it('tracks native focus through events instead of an unsupported synchronous view function', () => {
    expect(iosSource).toContain('onInputFocus')
    expect(iosSource).toContain('onInputBlur')
    expect(androidSource).toContain('onInputFocus')
    expect(androidSource).toContain('onInputBlur')
    expect(iosModuleSource).toContain('Events("onCommittedText", "onInputFocus", "onInputBlur"')
    expect(androidModuleSource).toContain('Events("onCommittedText", "onInputFocus", "onInputBlur"')
    expect(iosModuleSource).not.toContain('Function("isFocused")')
    expect(androidModuleSource).not.toContain('Function("isFocused")')
    const imperativeHandle = sourceBlock(
      nativeWrapperSource,
      'useImperativeHandle(',
      'const handleNativeCommittedText'
    )
    expect(imperativeHandle.indexOf('focusedRef.current = true')).toBeLessThan(
      imperativeHandle.indexOf('focusAsync()')
    )
    expect(imperativeHandle.indexOf('focusedRef.current = false')).toBeLessThan(
      imperativeHandle.indexOf('blurAsync()')
    )
  })

  it('uses the composition-aware native view for terminal live input', () => {
    expect(sessionRouteSource.includes('<TerminalLiveInputView')).toBe(true)
    expect(sessionRouteSource.includes('onCommittedText={handleLiveInputChange}')).toBe(true)
    expect(
      /<TextInput[\s\S]{0,500}onChangeText=\{handleLiveInputChange\}/.test(sessionRouteSource)
    ).toBe(false)
  })
})
