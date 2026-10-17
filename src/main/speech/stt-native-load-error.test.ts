import { describe, expect, it } from 'vitest'
import { describeSttNativeLoadError } from './stt-native-load-error'

const DLOPEN =
  'Error: dlopen(/Applications/Orca.app/Contents/Resources/node_modules/sherpa-onnx-darwin-x64/sherpa-onnx.node, 0x0001): Symbol not found: (__ZNSt3__18to_charsEPcS0_d)'

describe('describeSttNativeLoadError', () => {
  it('explains macOS dlopen failures and keeps the raw detail', () => {
    const out = describeSttNativeLoadError(DLOPEN, { platform: 'darwin', release: '21.6.0' })
    expect(out).toContain('macOS 12')
    expect(out).toContain('Update macOS')
    expect(out).toContain(DLOPEN)
  })

  it('leaves non-loader errors untouched', () => {
    expect(
      describeSttNativeLoadError('model not found', { platform: 'darwin', release: '21.6.0' })
    ).toBe('model not found')
  })

  it('leaves other platforms untouched', () => {
    expect(describeSttNativeLoadError(DLOPEN, { platform: 'linux', release: '6.8.0' })).toBe(DLOPEN)
  })
})
