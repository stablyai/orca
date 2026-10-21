import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_REMOTE_VIEWER_SSH_CONNECTION } from '../ipc/pty/host-env/codex-terminal-clipboard'
import { applyRemoteViewerLaunchEnv } from './remote-viewer-launch-env'

afterEach(() => vi.unstubAllEnvs())

describe('applyRemoteViewerLaunchEnv', () => {
  it.each([true, false])('marks a remote caller’s Codex (image support %s)', (supported) => {
    vi.stubEnv('SSH_CONNECTION', undefined)
    vi.stubEnv('SSH_TTY', undefined)
    const launch = { launchAgent: 'codex' as const, env: { KEEP: '1' } }
    expect(applyRemoteViewerLaunchEnv(launch, supported).env).toEqual({
      KEEP: '1',
      SSH_CONNECTION: CODEX_REMOTE_VIEWER_SSH_CONNECTION
    })
    expect(launch.env).toEqual({ KEEP: '1' })
  })

  it('leaves a launch from this host untouched', () => {
    const launch = { launchAgent: 'codex' as const }
    expect(applyRemoteViewerLaunchEnv(launch, undefined)).toBe(launch)
  })

  it('keeps an SSH session the launch already carries', () => {
    const launch = {
      launchAgent: 'codex' as const,
      env: { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }
    }
    expect(applyRemoteViewerLaunchEnv(launch, true)).toBe(launch)
  })

  it('still applies the Claude image rule and never marks Claude', () => {
    vi.stubEnv('CLAUDE_CODE_FORCE_TERMINAL_IMAGES', undefined)
    const launch: { launchAgent: 'claude'; env?: Record<string, string> } = {
      launchAgent: 'claude'
    }
    expect(applyRemoteViewerLaunchEnv(launch, false).env).toEqual({
      CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '0'
    })
  })
})
