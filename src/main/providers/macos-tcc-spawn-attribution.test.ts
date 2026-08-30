import { describe, it, expect, afterEach } from 'vitest'
import { readMacosTccAttribution } from './macos-tcc-spawn-attribution'

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function withPlatform<T>(value: NodeJS.Platform, run: () => T): T {
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return run()
}

afterEach(() => {
  if (realPlatform) {
    Object.defineProperty(process, 'platform', realPlatform)
  }
})

describe('readMacosTccAttribution', () => {
  it('reports disclaimed only when the native spawn says the attribute applied', () => {
    expect(withPlatform('darwin', () => readMacosTccAttribution({ tccDisclaim: 1 }))).toBe(
      'disclaimed'
    )
  })

  it('reports not-disclaimed when the SPI was missing or the call failed', () => {
    expect(withPlatform('darwin', () => readMacosTccAttribution({ tccDisclaim: 2 }))).toBe(
      'not-disclaimed'
    )
    expect(withPlatform('darwin', () => readMacosTccAttribution({ tccDisclaim: 3 }))).toBe(
      'not-disclaimed'
    )
  })

  // Why: an unpatched node-pty reports nothing; silence must never read as success (STA-3631).
  it('reports unknown when node-pty reports no verdict at all', () => {
    expect(withPlatform('darwin', () => readMacosTccAttribution({}))).toBe('unknown')
    expect(withPlatform('darwin', () => readMacosTccAttribution(undefined))).toBe('unknown')
    expect(withPlatform('darwin', () => readMacosTccAttribution(null))).toBe('unknown')
  })

  it('reports unknown for a non-numeric or unrecognized verdict', () => {
    expect(withPlatform('darwin', () => readMacosTccAttribution({ tccDisclaim: '1' }))).toBe(
      'unknown'
    )
    expect(withPlatform('darwin', () => readMacosTccAttribution({ tccDisclaim: 0 }))).toBe(
      'unknown'
    )
    expect(withPlatform('darwin', () => readMacosTccAttribution({ tccDisclaim: 99 }))).toBe(
      'unknown'
    )
  })

  // Why: disclaiming is a darwin spawn attribute; other hosts have nothing to claim either way.
  it('never claims disclaimed off macOS even if a verdict is present', () => {
    expect(withPlatform('linux', () => readMacosTccAttribution({ tccDisclaim: 1 }))).toBe('unknown')
    expect(withPlatform('win32', () => readMacosTccAttribution({ tccDisclaim: 1 }))).toBe('unknown')
  })
})
