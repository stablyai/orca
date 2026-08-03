import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  installClaude: vi.fn(),
  installCodex: vi.fn(),
  removeClaude: vi.fn(),
  removeCodex: vi.fn(),
  statusClaude: vi.fn(),
  statusCodex: vi.fn()
}))

vi.mock('./local-agent-cli-presence', () => ({
  detectLocalManagedAgentCliPresence: mocks.detect
}))

vi.mock('./managed-agent-hook-registry', () => ({
  MANAGED_AGENT_HOOK_INSTALLERS: [
    ['claude', mocks.installClaude],
    ['codex', mocks.installCodex]
  ],
  MANAGED_AGENT_HOOK_REMOVERS: [
    ['claude', mocks.removeClaude],
    ['codex', mocks.removeCodex]
  ],
  MANAGED_AGENT_HOOK_STATUS_READERS: [
    ['claude', mocks.statusClaude],
    ['codex', mocks.statusCodex]
  ]
}))

import {
  applyAgentStatusHooksEnabled,
  installManagedAgentHooks
} from './managed-agent-hook-controls'

function status(agent: 'claude' | 'codex', state: 'installed' | 'not_installed') {
  return {
    agent,
    state,
    configPath: `/${agent}`,
    managedHooksPresent: state === 'installed',
    detail: null
  } as const
}

describe('managed agent hook controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.installClaude.mockReturnValue(status('claude', 'installed'))
    mocks.installCodex.mockReturnValue(status('codex', 'installed'))
    mocks.removeClaude.mockReturnValue(status('claude', 'not_installed'))
    mocks.removeCodex.mockReturnValue(status('codex', 'not_installed'))
  })

  it('installs only agents with positively detected CLIs', async () => {
    mocks.detect.mockResolvedValue({
      claude: { state: 'missing' },
      codex: { state: 'found' }
    })

    const results = await installManagedAgentHooks({ agentCmdOverrides: {} })

    expect(mocks.installClaude).not.toHaveBeenCalled()
    expect(mocks.installCodex).toHaveBeenCalledTimes(1)
    expect(results).toEqual([
      expect.objectContaining({
        agent: 'claude',
        state: 'skipped',
        skipReason: 'cli_not_found'
      }),
      expect.objectContaining({ agent: 'codex', state: 'installed' })
    ])
  })

  it('fails closed when CLI detection rejects', async () => {
    mocks.detect.mockRejectedValue(new Error('detection unavailable'))

    const results = await installManagedAgentHooks({ agentCmdOverrides: {} })

    expect(mocks.installClaude).not.toHaveBeenCalled()
    expect(mocks.installCodex).not.toHaveBeenCalled()
    expect(results).toEqual([
      expect.objectContaining({
        agent: 'claude',
        state: 'skipped',
        skipReason: 'cli_presence_unknown'
      }),
      expect.objectContaining({
        agent: 'codex',
        state: 'skipped',
        skipReason: 'cli_presence_unknown'
      })
    ])
  })

  it('removes disabled agents without probing or reinstalling them', async () => {
    mocks.detect.mockResolvedValue({ codex: { state: 'found' } })

    const results = await applyAgentStatusHooksEnabled(true, {
      agentCmdOverrides: {},
      disabledTuiAgents: ['claude']
    })

    expect(mocks.removeClaude).toHaveBeenCalledTimes(1)
    expect(mocks.installClaude).not.toHaveBeenCalled()
    expect(mocks.installCodex).toHaveBeenCalledTimes(1)
    expect(results).toEqual([
      expect.objectContaining({ agent: 'claude', state: 'not_installed' }),
      expect.objectContaining({ agent: 'codex', state: 'installed' })
    ])
  })

  it('does not install an agent disabled while detection was running', async () => {
    mocks.detect.mockResolvedValue({
      claude: { state: 'found' },
      codex: { state: 'found' }
    })

    await installManagedAgentHooks(
      { agentCmdOverrides: {} },
      { shouldContinue: (agent) => agent !== 'claude' }
    )

    expect(mocks.installClaude).not.toHaveBeenCalled()
    expect(mocks.installCodex).toHaveBeenCalledTimes(1)
  })

  it('does not remove an agent enabled by a newer settings update', async () => {
    mocks.detect.mockResolvedValue({ codex: { state: 'found' } })

    await applyAgentStatusHooksEnabled(
      true,
      {
        agentCmdOverrides: {},
        disabledTuiAgents: ['claude']
      },
      { shouldContinue: () => true }
    )

    expect(mocks.removeClaude).not.toHaveBeenCalled()
  })

  it('removes every managed hook when the global setting is off', async () => {
    await applyAgentStatusHooksEnabled(false)

    expect(mocks.detect).not.toHaveBeenCalled()
    expect(mocks.removeClaude).toHaveBeenCalledTimes(1)
    expect(mocks.removeCodex).toHaveBeenCalledTimes(1)
  })
})
