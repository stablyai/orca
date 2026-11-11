import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/command-path/agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: vi.fn()
}))

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectInstalledAgents } from './installed-agent-detection'
import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from '../../shared/agent-launch/catalog/tui-agent-detection-commands'

describe('detectInstalledAgents command overrides', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orca agent override '))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists an agent outside PATH only when its override executable exists', async () => {
    const executable = path.join(dir, process.platform === 'win32' ? 'ante.exe' : 'ante')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o755)

    await expect(
      detectInstalledAgents(undefined, { agentCmdOverrides: { ante: `"${executable}"` } })
    ).resolves.toContain('ante')
    await expect(
      detectInstalledAgents(undefined, {
        agentCmdOverrides: { ante: `"${path.join(dir, 'missing', 'ante')}"` }
      })
    ).resolves.not.toContain('ante')
  })
})

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
