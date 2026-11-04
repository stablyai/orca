import { describe, expect, it } from 'vitest'
import { RuntimeTerminalAgentPresence } from './runtime-terminal-agent-presence'

/** A pane that runs wsl.exe on Windows: the guest's OpenCode is invisible to the host. */
function presenceWith(overrides: Record<string, unknown>, foreground: string | null) {
  const pty = {
    ptyId: 'pty_1',
    title: null,
    titleUpdatedAt: null,
    lastOscTitle: null,
    lastOscTitleAt: null,
    launchAgent: null,
    lastAgentStatus: null,
    managementTitle: null,
    managementTitleAt: null,
    tailBuffer: '',
    tailPartialLine: null,
    preview: '',
    ...overrides
  }
  return new RuntimeTerminalAgentPresence({
    getLivePty: () => pty,
    getLiveLeaf: () => null,
    getPrimaryLeaf: () => null,
    getTrackedPty: () => null,
    getTabTitle: () => null,
    getForegroundProcess: async () => foreground,
    confirmForegroundProcess: async () => foreground,
    getTitleDisplayClear: () => null
  } as never)
}

describe('RuntimeTerminalAgentPresence with an OpenCode native title', () => {
  it('accepts a tracked agent status when the shell started OpenCode (#37815)', async () => {
    // No launchAgent record and only wsl.exe as foreground: the status feed is the
    // live evidence that the guest's OpenCode is still running.
    const presence = presenceWith(
      { title: 'OC | fixing the build', lastAgentStatus: 'working' },
      'wsl.exe'
    )
    await expect(
      presence.isRunning('term_1', { retryForegroundWrappers: false })
    ).resolves.toBe(true)
  })

  it('still refuses the same title without any tracked status', async () => {
    const presence = presenceWith({ title: 'OC | fixing the build' }, 'wsl.exe')
    await expect(
      presence.isRunning('term_1', { retryForegroundWrappers: false })
    ).resolves.toBe(false)
  })

  it('keeps a management title from proving presence through status alone', async () => {
    const presence = presenceWith(
      {
        title: 'OC | fixing the build',
        lastAgentStatus: 'working',
        managementTitle: 'claude agents',
        managementTitleAt: 1
      },
      'wsl.exe'
    )
    await expect(
      presence.isRunning('term_1', { retryForegroundWrappers: false })
    ).resolves.toBe(false)
  })
})
