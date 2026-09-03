import { describe, expect, it, vi } from 'vitest'
import {
  MAX_QUICK_COMMANDS,
  OrcaRuntimeService,
  applyAgentStatusHooksEnabledMock,
  electronMocks
} from '../orca-runtime-test-mocks.spec'
import { deferred, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('projects runtime-backed settings to paired clients', () => {
    const terminalQuickCommands = [
      {
        id: 'review',
        label: 'Review',
        action: 'agent-prompt' as const,
        agent: 'codex' as const,
        prompt: 'Review this diff',
        scope: { type: 'global' as const }
      }
    ]
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        hostSettingOverrides: {
          'ssh:target-1': { displayLabel: 'Build host', defaultWorktreeLocation: '/srv/worktrees' }
        },
        experimentalNewWorktreeCardStyle: true,
        compactWorktreeCards: true,
        minimaxGroupId: 'group-42',
        minimaxUsageModels: 'general,abab6.5',
        terminalQuickCommands
      })
    } as never)

    expect(runtime.getClientSettings()).toMatchObject({
      worktreeVisibilityDefaults: { external: 'hide' },
      experimentalNewWorktreeCardStyle: true,
      compactWorktreeCards: true,
      minimaxGroupId: 'group-42',
      minimaxUsageModels: 'general,abab6.5'
    })
    expect(runtime.getClientSettings()).not.toHaveProperty('terminalQuickCommands')
    expect(runtime.getClientSettings().hostSettingOverrides).toEqual({
      'ssh:target-1': { displayLabel: 'Build host' }
    })
    expect(runtime.getClientTerminalQuickCommands()).toEqual(terminalQuickCommands)
  })

  it('updates quick commands without widening general paired settings payloads', () => {
    const existing = {
      id: 'review',
      label: 'Review',
      action: 'terminal-command' as const,
      command: 'pnpm review',
      appendEnter: true,
      scope: { type: 'global' as const }
    }
    let settings = { ...store.getSettings(), terminalQuickCommands: [existing] }
    const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings
    } as never)
    const command = {
      id: 'status',
      label: 'Status',
      action: 'terminal-command' as const,
      command: 'git status',
      appendEnter: true,
      scope: { type: 'global' as const }
    }
    const commands = [existing, command]

    expect(runtime.updateClientTerminalQuickCommands({ type: 'upsert', command })).toEqual(commands)
    expect(updateSettings).toHaveBeenCalledWith(
      { terminalQuickCommands: commands },
      { notifyListeners: true }
    )
    expect(runtime.getClientSettings()).not.toHaveProperty('terminalQuickCommands')
  })

  it('rejects a concurrent add after the quick command limit is reached', () => {
    const terminalQuickCommands = Array.from({ length: MAX_QUICK_COMMANDS }, (_, index) => ({
      id: `command-${index}`,
      label: `Command ${index}`,
      action: 'terminal-command' as const,
      command: 'true',
      appendEnter: true,
      scope: { type: 'global' as const }
    }))
    const updateSettings = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({ ...store.getSettings(), terminalQuickCommands }),
      updateSettings
    } as never)

    expect(() =>
      runtime.updateClientTerminalQuickCommands({
        type: 'upsert',
        command: {
          id: 'one-too-many',
          label: 'One too many',
          action: 'terminal-command',
          command: 'true',
          appendEnter: true,
          scope: { type: 'global' }
        }
      })
    ).toThrow('Quick command limit reached')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('accepts runtime-backed setting updates from paired clients', async () => {
    let settings = {
      ...store.getSettings(),
      experimentalNewWorktreeCardStyle: false,
      compactWorktreeCards: false,
      minimaxGroupId: '',
      minimaxUsageModels: 'general'
    }
    const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings
    } as never)

    expect(
      await runtime.updateClientSettings({
        experimentalNewWorktreeCardStyle: true,
        compactWorktreeCards: true,
        minimaxGroupId: 'group-42',
        minimaxUsageModels: 'general,abab6.5'
      })
    ).toMatchObject({
      experimentalNewWorktreeCardStyle: true,
      compactWorktreeCards: true,
      minimaxGroupId: 'group-42',
      minimaxUsageModels: 'general,abab6.5'
    })
    expect(updateSettings).toHaveBeenCalledWith(
      {
        experimentalNewWorktreeCardStyle: true,
        compactWorktreeCards: true,
        minimaxGroupId: 'group-42',
        minimaxUsageModels: 'general,abab6.5'
      },
      { notifyListeners: true }
    )
    expect(runtime.getClientSettings()).toMatchObject({
      experimentalNewWorktreeCardStyle: true,
      compactWorktreeCards: true,
      minimaxGroupId: 'group-42',
      minimaxUsageModels: 'general,abab6.5'
    })
  })

  it('broadcasts visibility default changes to paired clients', async () => {
    let settings = { ...store.getSettings(), worktreeVisibilityDefaults: { external: 'hide' } }
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings: (updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
      }
    } as never)
    const events: unknown[] = []
    runtime.onClientEvent((event) => events.push(event))

    await runtime.updateClientSettings({ worktreeVisibilityDefaults: { external: 'show' } })

    expect(events).toContainEqual({ type: 'reposChanged' })
  })

  it('reconciles hooks only when paired-client hook settings change', async () => {
    electronMocks.app.isPackaged = true
    let settings = {
      ...store.getSettings(),
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['codex', 'claude']
    }
    const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings
    } as never)

    await runtime.updateClientSettings({ disabledTuiAgents: ['claude', 'codex'] })
    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()

    await runtime.updateClientSettings({ disabledTuiAgents: ['claude'] })
    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledOnce()
    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ disabledTuiAgents: ['claude'] }),
      expect.objectContaining({
        shouldContinue: expect.any(Function),
        shouldHydrateShellPath: true
      })
    )
  })

  it('serializes paired-client hook reconciliation and reads current settings', async () => {
    let settings = {
      ...store.getSettings(),
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['codex', 'claude']
    }
    const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
    const firstReconciliation = deferred<[]>()
    applyAgentStatusHooksEnabledMock
      .mockImplementationOnce(() => firstReconciliation.promise)
      .mockResolvedValueOnce([])
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => settings,
      updateSettings
    } as never)

    const first = runtime.updateClientSettings({ disabledTuiAgents: ['claude'] })
    await vi.waitFor(() => expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledOnce())
    const second = runtime.updateClientSettings({ disabledTuiAgents: [] })

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledOnce()
    const firstOptions = applyAgentStatusHooksEnabledMock.mock.calls[0]?.[2]
    expect(firstOptions?.shouldContinue?.('claude')).toBe(true)

    firstReconciliation.resolve([])
    await Promise.all([first, second])

    expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledTimes(2)
    expect(applyAgentStatusHooksEnabledMock).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ disabledTuiAgents: [] }),
      expect.objectContaining({ shouldContinue: expect.any(Function) })
    )
  })

  it('rejects relative paths for runtime nested repo scan/import', async () => {
    const runtime = new OrcaRuntimeService({
      ...store,
      createProjectGroup: vi.fn(),
      moveProjectToGroup: vi.fn()
    } as never)

    await expect(runtime.scanNestedRepos('relative/project')).rejects.toThrow(
      'Project path must be an absolute path'
    )
    await expect(
      runtime.importNestedRepos({
        parentPath: 'relative/project',
        groupName: 'Project',
        projectPaths: ['relative/project/api'],
        mode: 'group'
      })
    ).rejects.toThrow('Project path must be an absolute path')
  })
})
