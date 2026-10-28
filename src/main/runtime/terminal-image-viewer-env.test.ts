import { afterEach, describe, expect, it, vi } from 'vitest'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import { TERMINAL_IMAGE_VIEWER_CAPABILITY } from '../../shared/terminal-image-viewer-capability'
import {
  applyClaudeTerminalImageViewerEnv,
  terminalImageViewerSupported
} from './terminal-image-viewer-env'

const paired = { caller: { kind: 'paired-device', deviceId: 'phone' } as const }
afterEach(() => vi.unstubAllEnvs())
describe('Claude images follow the launching viewer', () => {
  it.each([undefined, [], NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES])(
    'keeps older and native clients on old output %#',
    (clientCapabilities) => {
      expect(
        terminalImageViewerSupported({ ...paired, clientKind: 'runtime', clientCapabilities })
      ).toBe(false)
    }
  )
  it('enables a capable paired Electron viewer', () => {
    expect(
      terminalImageViewerSupported({
        ...paired,
        clientKind: 'runtime',
        clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      })
    ).toBe(true)
  })
  it('does not treat a mobile viewer as an image renderer', () => {
    expect(
      terminalImageViewerSupported({
        ...paired,
        clientKind: 'mobile',
        clientCapabilities: [TERMINAL_IMAGE_VIEWER_CAPABILITY]
      })
    ).toBe(false)
  })
  it.each([
    {},
    { ...paired },
    { ...paired, clientCapabilities: [TERMINAL_IMAGE_VIEWER_CAPABILITY] },
    { clientKind: 'runtime' as const, clientCapabilities: [TERMINAL_IMAGE_VIEWER_CAPABILITY] },
    { caller: { kind: 'local-cli' as const }, connectionId: 'remote' },
    { caller: { kind: 'local-cli' as const }, pairedDeviceId: 'remote' },
    { caller: { kind: 'local-cli' as const }, clientId: 'remote' }
  ])('fails closed for an unclassified or remote context %#', (context) => {
    expect(terminalImageViewerSupported(context)).toBe(false)
  })
  it.each([
    { caller: { kind: 'desktop' as const }, clientKind: 'runtime' as const },
    { caller: { kind: 'local-cli' as const } }
  ])('keeps same-build local launches on their existing policy %#', (context) => {
    expect(terminalImageViewerSupported(context)).toBeUndefined()
  })
  it.each([undefined, true])('keeps supported or local env unchanged (%s)', (supported) => {
    vi.stubEnv('CLAUDE_CODE_FORCE_TERMINAL_IMAGES', undefined)
    const launch = { launchAgent: 'claude' as const, env: { KEEP: 'yes' } }
    expect(applyClaudeTerminalImageViewerEnv(launch, supported)).toBe(launch)
  })
  it('disables automatic image forcing only for unsupported Claude', () => {
    vi.stubEnv('CLAUDE_CODE_FORCE_TERMINAL_IMAGES', undefined)
    const launch = { launchAgent: 'claude' as const, env: { KEEP: 'yes' } }
    expect(applyClaudeTerminalImageViewerEnv(launch, false).env).toEqual({
      KEEP: 'yes',
      CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '0'
    })
    expect(launch.env).toEqual({ KEEP: 'yes' })
    const codex = { launchAgent: 'codex' as const }
    expect(applyClaudeTerminalImageViewerEnv(codex, false)).toBe(codex)
  })
  it.each(['0', '1', ''])('preserves explicit and inherited override %j', (value) => {
    vi.stubEnv('CLAUDE_CODE_FORCE_TERMINAL_IMAGES', undefined)
    const explicit = {
      launchAgent: 'claude' as const,
      env: { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: value }
    }
    expect(applyClaudeTerminalImageViewerEnv(explicit, false)).toBe(explicit)
    vi.stubEnv('CLAUDE_CODE_FORCE_TERMINAL_IMAGES', value)
    const inherited = { launchAgent: 'claude' as const }
    expect(applyClaudeTerminalImageViewerEnv(inherited, false)).toBe(inherited)
  })
})
