import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../daemon/daemon-session-info'
import { daemonBridgeSessionVerdict } from './wsl-bridge-daemon-sessions'

function session(fields: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 's',
    state: 'running',
    shellState: 'ready',
    isAlive: true,
    pid: 1,
    cwd: null,
    cols: 80,
    rows: 24,
    createdAt: 0,
    ...fields
  }
}

describe("the daemon's bridge sessions for a relay's distro", () => {
  it('finds a live session named for the distro, in any case', () => {
    expect(daemonBridgeSessionVerdict([session({ wslDistro: 'ubuntu' })], 'Ubuntu')).toBe('live')
  })

  it('reads an older daemon’s session by its WSL folder', () => {
    expect(
      daemonBridgeSessionVerdict([session({ cwd: '\\\\wsl.localhost\\Ubuntu\\home\\u' })], 'Ubuntu')
    ).toBe('live')
  })
})
