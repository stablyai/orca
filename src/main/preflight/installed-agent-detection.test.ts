import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/command-path/agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: vi.fn()
}))

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectInstalledAgents } from './installed-agent-detection'
import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from '../../shared/agent-launch/catalog/tui-agent-detection-commands'

describe('strict installed-agent detection on WSL', () => {
  const platform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    runWslProcessMock.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  })

  it('propagates failed host admission even when every agent is disabled', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: false,
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    await expect(
      detectInstalledAgents(
        { wslDistro: 'Ubuntu' },
        {
          failOnProbeError: true,
          disabledTuiAgents: KNOWN_TUI_AGENT_DETECTION_COMMANDS.map(({ id }) => id)
        }
      )
    ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
  })

  it('keeps default discovery additive when a configured WSL override is missing', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout: '__ORCA_AGENT_PATH__ante\t/usr/bin/ante\n',
      stderr: '',
      timedOut: false
    })
    await expect(
      detectInstalledAgents(
        { wslDistro: 'Ubuntu' },
        { failOnProbeError: true, agentCmdOverrides: { ante: '~/missing/ante' } }
      )
    ).resolves.toContain('ante')
  })
})
