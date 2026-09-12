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
  refreshCodex: vi.fn()
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
  shouldInstallStartupManagedAgentHook,
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

    // Why (#11549 aftermath): the skipped agent's user-wide config still invokes the
    // script, so a stale (leaking) script must not be frozen by the presence gate.
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
    // Why waitFor and not a fixed microtask tick: the install path awaits session reconcilers
    // before refreshing scripts, so the number of ticks before this point is an implementation
    // detail. The assertion below is the real contract: no CLI probe until the refresh resolves.
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

  it('awaits only the selected asynchronous removers during quit', async () => {
    const results = await removeManagedAgentHooksAsync({ agents: ['codex'] })

    expect(mocks.removeClaudeAsync).not.toHaveBeenCalled()
    expect(mocks.removeCodexAsync).toHaveBeenCalledTimes(1)
    expect(results).toEqual([expect.objectContaining({ agent: 'codex', state: 'not_installed' })])
  })
})

describe('startup managed hook reconciliation (STA-5679)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips instead of removing when this profile has the off switch set', () => {
    // Why this matters: the hook files are user-global. Startup removal here deleted the hooks that
    // every other Orca instance depends on, and Cursor then reads as idle with no status at all.
    expect(resolveStartupManagedHookAction({ agentStatusHooksEnabled: false })).toBe('skip')
  })

  it('installs when hooks are enabled or the setting is unset', () => {
    expect(resolveStartupManagedHookAction({ agentStatusHooksEnabled: true })).toBe('install')
    expect(resolveStartupManagedHookAction({})).toBe('install')
    expect(resolveStartupManagedHookAction(null)).toBe('install')
  })

  it('only allows startup installs for globally enabled and agent-enabled hooks', () => {
    expect(shouldInstallStartupManagedAgentHook({ agentStatusHooksEnabled: false }, 'codex')).toBe(
      false
    )
    expect(
      shouldInstallStartupManagedAgentHook(
        { agentStatusHooksEnabled: true, disabledTuiAgents: ['codex'] },
        'codex'
      )
    ).toBe(false)
    expect(
      shouldInstallStartupManagedAgentHook(
        { agentStatusHooksEnabled: true, disabledTuiAgents: ['claude'] },
        'codex'
      )
    ).toBe(true)
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

  it('still removes through the explicit Settings toggle', async () => {
    // Anchors the assertion above: the removers really are wired, so 'skip' is a behavioral
    // difference rather than a vacuous constant.
    mocks.removeClaude.mockResolvedValue(status('claude', 'not_installed'))
    mocks.removeCodex.mockResolvedValue(status('codex', 'not_installed'))

    await applyAgentStatusHooksEnabled(false, { agentStatusHooksEnabled: false })

    expect(mocks.removeClaude).toHaveBeenCalledTimes(1)
    expect(mocks.removeCodex).toHaveBeenCalledTimes(1)
  })
})
