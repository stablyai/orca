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

vi.mock('../../claude/claude-hook-event-versions', () => ({
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

  // R42: on a WSL host the bridge's panes in the same distro still run on these entries.

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
