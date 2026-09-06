import { describe, expect, it } from 'vitest'
import { parseHostedWebViewSimulatorE2eOptions } from '../../scripts/hosted-webview-simulator-e2e-options.mjs'

describe('hosted WebView simulator E2E options', () => {
  it('retains bounded defaults', () => {
    expect(parseHostedWebViewSimulatorE2eOptions([])).toEqual({
      accountsOnly: false,
      adversarialContent: false,
      clipboardImageOnly: false,
      device: 'iPhone 17 Pro',
      expectedBuild: undefined,
      filesPreviewOnly: false,
      isolationOnly: false,
      nativeSettingsOnly: false,
      photosRevocationOnly: false,
      reuseNativeInstall: false,
      securityOnly: false,
      skipNativeBuild: false,
      sourceControlOnly: false,
      timeoutMs: 180_000
    })
  })

  it('reuses an installed app without selecting the cached reinstall path', () => {
    expect(parseHostedWebViewSimulatorE2eOptions(['--reuse-native-install'])).toMatchObject({
      reuseNativeInstall: true,
      skipNativeBuild: false
    })
    expect(() =>
      parseHostedWebViewSimulatorE2eOptions(['--reuse-native-install', '--skip-native-build'])
    ).toThrow('mutually exclusive')
  })

  it('accepts only canonical expected build identities', () => {
    const buildId = 'a'.repeat(64)
    expect(parseHostedWebViewSimulatorE2eOptions(['--expected-build', buildId])).toMatchObject({
      expectedBuild: buildId
    })
    expect(() =>
      parseHostedWebViewSimulatorE2eOptions(['--expected-build', 'A'.repeat(64)])
    ).toThrow('lowercase SHA-256')
  })

  it('parses the focused cached-app journey', () => {
    expect(
      parseHostedWebViewSimulatorE2eOptions([
        '--',
        '--device',
        'simulator-id',
        '--timeout-ms',
        '60000',
        '--native-settings-only',
        '--skip-native-build'
      ])
    ).toMatchObject({
      device: 'simulator-id',
      nativeSettingsOnly: true,
      skipNativeBuild: true,
      timeoutMs: 60_000
    })
  })

  it('maps the clipboard-image journey onto focused security setup', () => {
    expect(parseHostedWebViewSimulatorE2eOptions(['--clipboard-image-only'])).toMatchObject({
      clipboardImageOnly: true,
      securityOnly: true
    })
  })

  it('maps the Photos revocation journey onto focused security setup', () => {
    expect(parseHostedWebViewSimulatorE2eOptions(['--photos-revocation-only'])).toMatchObject({
      photosRevocationOnly: true,
      securityOnly: true
    })
  })

  it('maps WebView isolation onto focused security setup', () => {
    expect(parseHostedWebViewSimulatorE2eOptions(['--isolation-only'])).toMatchObject({
      isolationOnly: true,
      securityOnly: true
    })
  })

  it('maps adversarial content onto the focused Source Control journey', () => {
    expect(parseHostedWebViewSimulatorE2eOptions(['--adversarial-content'])).toMatchObject({
      adversarialContent: true,
      sourceControlOnly: true
    })
  })

  it('rejects mutually exclusive focused journeys', () => {
    expect(() =>
      parseHostedWebViewSimulatorE2eOptions(['--accounts-only', '--source-control-only'])
    ).toThrow('mutually exclusive')
    expect(() =>
      parseHostedWebViewSimulatorE2eOptions(['--clipboard-image-only', '--security-only'])
    ).toThrow('mutually exclusive')
    expect(() =>
      parseHostedWebViewSimulatorE2eOptions(['--clipboard-image-only', '--photos-revocation-only'])
    ).toThrow('mutually exclusive')
    expect(() =>
      parseHostedWebViewSimulatorE2eOptions(['--isolation-only', '--security-only'])
    ).toThrow('mutually exclusive')
  })

  it('rejects invalid timeouts and unknown arguments', () => {
    expect(() => parseHostedWebViewSimulatorE2eOptions(['--timeout-ms', '9999'])).toThrow(
      'at least 10000'
    )
    expect(() => parseHostedWebViewSimulatorE2eOptions(['--unknown'])).toThrow('Unknown argument')
  })
})
