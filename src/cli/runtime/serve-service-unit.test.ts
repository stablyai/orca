import { describe, expect, it } from 'vitest'
import { renderServeService, systemdQuote, type ServeServiceInput } from './serve-service-unit'

const base: ServeServiceInput = {
  platform: 'darwin',
  homeDir: '/Users/me',
  command: '/usr/local/bin/orca',
  userDataPath: '/Users/me/Library/Application Support/orca',
  defaultUserDataPath: '/Users/me/Library/Application Support/orca',
  path: '/usr/local/bin:/usr/bin:/bin'
}

describe('renderServeService', () => {
  it('writes a LaunchAgent that supervises, never pairs, and stops after a give-up', () => {
    const spec = renderServeService({ ...base, port: '6768' })
    expect(spec.name).toBe('com.stablyai.orca.serve')
    expect(spec.unitPath).toBe('/Users/me/Library/LaunchAgents/com.stablyai.orca.serve.plist')
    expect(spec.content).toContain('<string>--supervise</string>')
    expect(spec.content).toContain('<string>--no-pairing</string>')
    expect(spec.content).toContain('<string>6768</string>')
    expect(spec.content).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>90<\/integer>/)
    expect(spec.content).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(spec.content).toContain('<key>ORCA_USER_DATA_PATH</key>')
  })

  it('gives another profile its own label and pins its userData', () => {
    const spec = renderServeService({ ...base, userDataPath: '/tmp/profile & co' })
    expect(spec.name).toMatch(/^com\.stablyai\.orca\.serve\.[0-9a-f]{8}$/)
    expect(spec.content).toContain('<string>/tmp/profile &amp; co</string>')
  })

  it('writes a systemd user unit with a start limit and quoted arguments', () => {
    const spec = renderServeService({
      ...base,
      platform: 'linux',
      homeDir: '/home/me',
      command: '/home/me/My Apps/orca-ide',
      userDataPath: '/home/me/.config/orca',
      defaultUserDataPath: '/home/me/.config/orca',
      pairingAddress: '100.64.0.1'
    })
    expect(spec.unitPath).toBe('/home/me/.config/systemd/user/orca-serve.service')
    expect(spec.content).toContain('StartLimitBurst=5')
    expect(spec.content).toContain('TimeoutStopSec=90')
    expect(spec.content).toContain(
      'ExecStart="/home/me/My Apps/orca-ide" serve --supervise --no-pairing --pairing-address 100.64.0.1'
    )
  })

  it('refuses Windows', () => {
    expect(() => renderServeService({ ...base, platform: 'win32' })).toThrow()
  })

  it('quotes for systemd', () => {
    expect(systemdQuote('plain')).toBe('plain')
    expect(systemdQuote('50%')).toBe('50%%')
    expect(systemdQuote('a "b"\\c')).toBe('"a \\"b\\"\\\\c"')
  })
})
