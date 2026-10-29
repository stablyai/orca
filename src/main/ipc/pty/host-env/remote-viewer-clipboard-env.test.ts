import { describe, expect, it } from 'vitest'
import {
  applyRemoteViewerClipboardEnv,
  CODEX_REMOTE_VIEWER_SSH_CONNECTION,
  PI_CLIPBOARD_OSC52_ENV
} from './remote-viewer-clipboard-env'

describe('applyRemoteViewerClipboardEnv', () => {
  // #33937: pi run by hand in a remote shell copied only to the host's clipboard.
  it.each([undefined, 'pi', 'claude'] as const)(
    'asks pi for OSC 52 copies in every %s pane a remote viewer watches',
    (launchAgent) => {
      const env: Record<string, string> = {}
      applyRemoteViewerClipboardEnv(env, { launchAgent, viewerIsRemote: true, inheritedEnv: {} })
      expect(env[PI_CLIPBOARD_OSC52_ENV]).toBe('1')
    }
  )

  it('leaves the pi clipboard route alone for a local viewer or an explicit user value', () => {
    const local: Record<string, string> = {}
    applyRemoteViewerClipboardEnv(local, {
      launchAgent: undefined,
      viewerIsRemote: false,
      inheritedEnv: {}
    })
    expect(local[PI_CLIPBOARD_OSC52_ENV]).toBeUndefined()
    const optedOut: Record<string, string> = {}
    applyRemoteViewerClipboardEnv(optedOut, {
      launchAgent: undefined,
      viewerIsRemote: true,
      inheritedEnv: { [PI_CLIPBOARD_OSC52_ENV]: '0' }
    })
    expect(optedOut[PI_CLIPBOARD_OSC52_ENV]).toBeUndefined()
  })

  it('marks a Codex launch on a host the viewer is not sitting at', () => {
    const env: Record<string, string> = {}
    applyRemoteViewerClipboardEnv(env, {
      launchAgent: 'codex',
      viewerIsRemote: true,
      inheritedEnv: {}
    })
    expect(env.SSH_CONNECTION).toBe(CODEX_REMOTE_VIEWER_SSH_CONNECTION)
  })

  it('leaves a local Codex launch alone', () => {
    const env: Record<string, string> = {}
    applyRemoteViewerClipboardEnv(env, {
      launchAgent: 'codex',
      viewerIsRemote: false,
      inheritedEnv: {}
    })
    expect(env.SSH_CONNECTION).toBeUndefined()
  })

  it.each([undefined, 'claude'] as const)('leaves a %s launch alone', (launchAgent) => {
    const env: Record<string, string> = {}
    applyRemoteViewerClipboardEnv(env, { launchAgent, viewerIsRemote: true, inheritedEnv: {} })
    expect(env.SSH_CONNECTION).toBeUndefined()
  })

  it('never overrides an SSH session the launch already carries', () => {
    const env: Record<string, string> = { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' }
    applyRemoteViewerClipboardEnv(env, {
      launchAgent: 'codex',
      viewerIsRemote: true,
      inheritedEnv: {}
    })
    expect(env.SSH_CONNECTION).toBe('10.0.0.1 5000 10.0.0.2 22')
  })

  it.each([
    ['SSH_CONNECTION', '10.0.0.1 5000 10.0.0.2 22'],
    ['SSH_TTY', '/dev/ttys004']
  ])('skips when the host process already inherits %s', (key, value) => {
    const env: Record<string, string> = {}
    applyRemoteViewerClipboardEnv(env, {
      launchAgent: 'codex',
      viewerIsRemote: true,
      inheritedEnv: { [key]: value }
    })
    expect(env.SSH_CONNECTION).toBeUndefined()
  })
})
