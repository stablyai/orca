import { describe, expect, it } from 'vitest'
import { readMobileSessionRouteSource } from '../session/mobile-session-route-source-family.test-support'

const commandDockSource = readMobileSessionRouteSource('../session/MobileSessionCommandDock.tsx')

describe('terminal iOS IME keyboard', () => {
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
