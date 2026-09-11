import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readMobileSessionRouteSource } from '../session/mobile-session-route-source-family.test-support'

const commandDockSource = readMobileSessionRouteSource('../session/MobileSessionCommandDock.tsx')

describe('terminal iOS IME keyboard', () => {
  it('opts only the iOS live capture into backspace repeat with an empty field', () => {
    const liveInput = commandDockSource.slice(
      commandDockSource.indexOf('ref={liveInputRef}'),
      commandDockSource.indexOf('ref={commandInputRef}')
    )
    expect(liveInput).toContain("allowEmptyBackspaceRepeat={Platform.OS === 'ios'}")
    expect(commandDockSource.match(/allowEmptyBackspaceRepeat=/g)).toHaveLength(1)
  })

  it('patches the iOS native repeat eligibility without injecting text or synthesizing deletions', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    )
    const version = manifest.dependencies['react-native'].replace(/^[^\d]*/, '')
    const patch = readFileSync(
      new URL(`../../patches/react-native@${version}.patch`, import.meta.url),
      'utf8'
    )
    expect(patch).toContain('+    allowEmptyBackspaceRepeat: true,')
    expect(patch).toContain('+  bool allowEmptyBackspaceRepeat{false};')
    expect(patch).toContain('+          "allowEmptyBackspaceRepeat",')
    expect(patch).toContain(
      '+    ((RCTUITextField *)_backedTextInputView).allowEmptyBackspaceRepeat = newTextInputProps.allowEmptyBackspaceRepeat;'
    )
    expect(patch).toContain(
      '+    ((RCTUITextField *)_backedTextInputView).allowEmptyBackspaceRepeat = NO;'
    )
    expect(patch).toContain('+  return _allowEmptyBackspaceRepeat || [super hasText];')
    expect(patch).not.toContain('+- (void)deleteBackward')
  })

  it('does not force terminal inputs onto the ASCII-only iOS keyboard', () => {
    expect(commandDockSource).not.toContain("'ascii-capable'")
    expect(commandDockSource).not.toContain('"ascii-capable"')
  })

  it('subscribes live capture to onChange so the marked-text report survives', () => {
    // onChangeText hands over only a string, discarding the preedit report that
    // decides whether the text may reach the PTY at all.
    expect(commandDockSource).toContain('onChange={handleLiveInputChange}')
    expect(commandDockSource).not.toContain('onChangeText={handleLiveInputChange}')
  })

  it('does not put terminal keyboard capture behind iOS textContentType semantics', () => {
    expect(commandDockSource).not.toContain('textContentType="none"')
    expect(commandDockSource).toContain('autoComplete="off"')
  })
})
