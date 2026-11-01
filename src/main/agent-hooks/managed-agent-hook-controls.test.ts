import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  installClaude: vi.fn(),
  installCodex: vi.fn(),
  removeClaude: vi.fn(),
  removeCodex: vi.fn(),
  removeClaudeAsync: vi.fn(),
  removeCodexAsync: vi.fn(),
  statusClaude: vi.fn(),
  statusCodex: vi.fn(),
  refreshClaude: vi.fn(),
  refreshCodex: vi.fn(),
  probeClaudeVersion: vi.fn()
}))

vi.mock('./local-agent-cli-presence', () => ({
  detectLocalManagedAgentCliPresence: mocks.detect
}))

vi.mock('../claude/claude-hook-event-versions', () => ({
  probeClaudeCliVersion: mocks.probeClaudeVersion
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
  MANAGED_AGENT_HOOK_ASYNC_REMOVERS: [
    ['claude', mocks.removeClaudeAsync],
    ['codex', mocks.removeCodexAsync]
  ],
  MANAGED_AGENT_HOOK_STATUS_READERS: [
    ['claude', mocks.statusClaude],
    ['codex', mocks.statusCodex]
  ],
  MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS: [
    ['claude', mocks.refreshClaude],
    ['codex', mocks.refreshCodex]
  ]
}))

import {
  applyAgentStatusHooksEnabled,
  installManagedAgentHooks,
  removeManagedAgentHooksAsync,
  resolveStartupManagedHookAction,
  shouldContinueManagedHookStartup
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
    mocks.removeClaudeAsync.mockResolvedValue(status('claude', 'not_installed'))
    mocks.removeCodexAsync.mockResolvedValue(status('codex', 'not_installed'))
    mocks.refreshClaude.mockResolvedValue(undefined)
    mocks.refreshCodex.mockResolvedValue(undefined)
    mocks.probeClaudeVersion.mockResolvedValue(null)
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

  it('refreshes existing scripts for agents whose CLI is no longer detected', async () => {
    mocks.detect.mockResolvedValue({
      claude: { state: 'missing' },
      codex: { state: 'found' }
    })

    await installManagedAgentHooks({ agentCmdOverrides: {} })

    // Existing scripts remain referenced by user-wide configs after CLI removal.
    expect(mocks.refreshClaude).toHaveBeenCalledTimes(1)
    expect(mocks.refreshCodex).toHaveBeenCalledTimes(1)
    expect(mocks.installClaude).not.toHaveBeenCalled()
  })

  it('refreshes existing scripts even when CLI detection rejects', async () => {
    mocks.detect.mockRejectedValue(new Error('detection unavailable'))

    await installManagedAgentHooks({ agentCmdOverrides: {} })

    expect(mocks.refreshClaude).toHaveBeenCalledTimes(1)
    expect(mocks.refreshCodex).toHaveBeenCalledTimes(1)
  })

  it('awaits each script refresh before probing for CLIs', async () => {
    let releaseRefresh: (() => void) | undefined
    mocks.refreshClaude.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRefresh = resolve
        })
    )
    mocks.detect.mockResolvedValue({
      claude: { state: 'missing' },
      codex: { state: 'missing' }
    })

    const install = installManagedAgentHooks({ agentCmdOverrides: {} })
    // Earlier awaits vary; wait for refresh entry before asserting that CLI probing is blocked.
    await vi.waitFor(() => expect(mocks.refreshClaude).toHaveBeenCalled())

    expect(mocks.detect).not.toHaveBeenCalled()
    releaseRefresh?.()
    await install
    expect(mocks.detect).toHaveBeenCalledTimes(1)
  })

  it('keeps installing when a script refresh throws', async () => {
    mocks.refreshClaude.mockRejectedValue(new Error('disk full'))
    mocks.detect.mockResolvedValue({
      claude: { state: 'found' },
      codex: { state: 'found' }
    })

    const results = await installManagedAgentHooks({ agentCmdOverrides: {} })

    expect(mocks.installClaude).toHaveBeenCalledTimes(1)
    expect(mocks.installCodex).toHaveBeenCalledTimes(1)
    expect(results).toEqual([
      expect.objectContaining({ agent: 'claude', state: 'installed' }),
      expect.objectContaining({ agent: 'codex', state: 'installed' })
    ])
  })

  it('forwards the detected Claude version to its installer', async () => {
    mocks.detect.mockResolvedValue({
      claude: { state: 'found', executablePath: '/opt/bin/claude' },
      codex: { state: 'missing' }
    })
    mocks.probeClaudeVersion.mockResolvedValue('2.1.261')

    await installManagedAgentHooks({ agentCmdOverrides: {} })

    expect(mocks.probeClaudeVersion).toHaveBeenCalledWith('/opt/bin/claude')
    expect(mocks.installClaude).toHaveBeenCalledWith({ cliVersion: '2.1.261' })
  })

  it('only refreshes scripts for the selected agents', async () => {
    mocks.detect.mockResolvedValue({ codex: { state: 'found' } })

    await installManagedAgentHooks({ agentCmdOverrides: {} }, { agents: ['codex'] })

    expect(mocks.refreshClaude).not.toHaveBeenCalled()
    expect(mocks.refreshCodex).toHaveBeenCalledTimes(1)
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

    expect(mocks.detect.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ agent: 'codex' })])
    expect(mocks.removeClaude).toHaveBeenCalledTimes(1)
    expect(mocks.installClaude).not.toHaveBeenCalled()
    expect(mocks.installCodex).toHaveBeenCalledTimes(1)
    expect(results).toEqual([
      expect.objectContaining({ agent: 'claude', state: 'not_installed' }),
      expect.objectContaining({ agent: 'codex', state: 'installed' })
    ])
  })

  it('does not install an agent disabled while detection was running', async () => {
    let releaseDetection: ((value: Record<string, { state: 'found' }>) => void) | undefined
    mocks.detect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDetection = resolve
        })
    )
    let claudeDisabled = false
    const install = installManagedAgentHooks(
      { agentCmdOverrides: {} },
      { shouldContinue: (agent) => agent !== 'claude' || !claudeDisabled }
    )
    try {
      await vi.waitFor(() => expect(mocks.detect).toHaveBeenCalledTimes(1))
      claudeDisabled = true
      releaseDetection?.({ claude: { state: 'found' }, codex: { state: 'found' } })
      const results = await install

      expect(mocks.installClaude).not.toHaveBeenCalled()
      expect(mocks.installCodex).toHaveBeenCalledTimes(1)
      expect(results).toEqual([
        expect.objectContaining({
          agent: 'claude',
          state: 'skipped',
          skipReason: 'hooks_disabled'
        }),
        expect.objectContaining({ agent: 'codex', state: 'installed' })
      ])
    } finally {
      releaseDetection?.({ claude: { state: 'found' }, codex: { state: 'found' } })
      await install
    }
  })

  it('does not finish a startup install after shutdown begins', async () => {
    let releaseDetection: ((value: Record<string, { state: 'found' }>) => void) | undefined
    mocks.detect.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDetection = resolve
        })
    )
    const settings = { agentStatusHooksEnabled: true, disabledTuiAgents: [] }
    let isQuitting = false

    const install = installManagedAgentHooks(settings, {
      shouldContinue: (agent) => shouldContinueManagedHookStartup(isQuitting, settings, agent)
    })
    await vi.waitFor(() => expect(mocks.detect).toHaveBeenCalledTimes(1))
    isQuitting = true
    releaseDetection?.({ claude: { state: 'found' }, codex: { state: 'found' } })
    await install

    expect(mocks.installClaude).not.toHaveBeenCalled()
    expect(mocks.installCodex).not.toHaveBeenCalled()
  })

  it('does not remove an agent enabled by a newer settings update', async () => {
    let releaseDetection: ((value: Record<string, { state: 'found' }>) => void) | undefined
    mocks.detect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDetection = resolve
        })
    )
    let claudeEnabled = false
    const update = applyAgentStatusHooksEnabled(
      true,
      { agentCmdOverrides: {}, disabledTuiAgents: ['claude'] },
      { shouldContinue: (agent) => agent !== 'claude' || claudeEnabled }
    )
    try {
      await vi.waitFor(() => expect(mocks.detect).toHaveBeenCalledTimes(1))
      claudeEnabled = true
      releaseDetection?.({ codex: { state: 'found' } })
      await update
      expect(mocks.removeClaude).not.toHaveBeenCalled()
      expect(mocks.installCodex).toHaveBeenCalledTimes(1)
    } finally {
      releaseDetection?.({ codex: { state: 'found' } })
      await update
    }
  })

  it('removes every managed hook when the global setting is off', async () => {
    await applyAgentStatusHooksEnabled(false)

    expect(mocks.detect).not.toHaveBeenCalled()
    expect(mocks.removeClaude).toHaveBeenCalledTimes(1)
    expect(mocks.removeCodex).toHaveBeenCalledTimes(1)
  })

  // R42: on a WSL host the bridge's panes in the same distro still run on these entries.
  it('keeps shared entries when told to: off skips, and a disabled agent keeps its entry', async () => {
    mocks.detect.mockResolvedValue({ codex: { state: 'found' } })
    mocks.statusClaude.mockReturnValue({ agent: 'claude', state: 'installed' })
    mocks.statusCodex.mockReturnValue({ agent: 'codex', state: 'installed' })

    await applyAgentStatusHooksEnabled(false, null, { keepSharedEntries: true })
    await applyAgentStatusHooksEnabled(
      true,
      { agentCmdOverrides: {}, disabledTuiAgents: ['claude'] },
      { keepSharedEntries: true }
    )

    expect(mocks.removeClaude).not.toHaveBeenCalled()
    expect(mocks.removeCodex).not.toHaveBeenCalled()
  })

  it('awaits only the selected asynchronous removers during quit', async () => {
    let finishRemoval: ((value: ReturnType<typeof status>) => void) | undefined
    mocks.removeCodexAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRemoval = resolve
        })
    )
    let settled = false
    const removal = removeManagedAgentHooksAsync({ agents: ['codex'] }).then((results) => {
      settled = true
      return results
    })
    try {
      await vi.waitFor(() => expect(mocks.removeCodexAsync).toHaveBeenCalledTimes(1))
      await Promise.resolve()
      expect(mocks.removeClaudeAsync).not.toHaveBeenCalled()
      expect(settled).toBe(false)
      finishRemoval?.(status('codex', 'not_installed'))
      await expect(removal).resolves.toEqual([
        expect.objectContaining({ agent: 'codex', state: 'not_installed' })
      ])
      expect(settled).toBe(true)
    } finally {
      finishRemoval?.(status('codex', 'not_installed'))
      await removal
    }
  })
})

describe('startup managed hook reconciliation (STA-5679)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips instead of removing when this profile has the off switch set', () => {
    expect(resolveStartupManagedHookAction({ agentStatusHooksEnabled: false })).toBe('skip')
  })

  it('installs when hooks are enabled or the setting is unset', () => {
    expect(resolveStartupManagedHookAction({ agentStatusHooksEnabled: true })).toBe('install')
    expect(resolveStartupManagedHookAction({})).toBe('install')
    expect(resolveStartupManagedHookAction(null)).toBe('install')
  })

  it('does not remove disabled agents during startup install reconciliation', async () => {
    const settings = {
      agentStatusHooksEnabled: true,
      agentCmdOverrides: {},
      disabledTuiAgents: ['claude' as const]
    }
    mocks.detect.mockResolvedValue({ codex: { state: 'found' } })

    await installManagedAgentHooks(settings, {
      shouldContinue: (agent) => shouldContinueManagedHookStartup(false, settings, agent)
    })

    expect(mocks.removeClaude).not.toHaveBeenCalled()
    expect(mocks.installClaude).not.toHaveBeenCalled()
    expect(mocks.installCodex).toHaveBeenCalledTimes(1)
  })
})
