import { describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('client UI RPC methods', () => {
  it('returns the runtime host agent settings needed by mobile create flows', async () => {
    const settings = {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['claude'],
      agentCmdOverrides: { codex: 'codex --profile work' },
      defaultTaskSource: 'gitlab',
      defaultTaskViewPreset: 'my-prs',
      visibleTaskProviders: ['github', 'gitlab'],
      defaultRepoSelection: ['repo-1'],
      defaultLinearTeamSelection: ['team-1'],
      githubProjects: {
        pinned: [],
        recent: [],
        lastViewByProject: {},
        activeProject: null
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => settings)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(makeRequest('settings.get'))

    expect(runtime.getClientSettings).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({ ok: true, result: { settings } })
  })

  it('persists the runtime host task source settings for mobile Tasks', async () => {
    const settings = {
      defaultTuiAgent: null,
      disabledTuiAgents: ['claude'],
      agentCmdOverrides: {},
      defaultTaskSource: 'linear',
      defaultTaskViewPreset: 'issues',
      visibleTaskProviders: ['github', 'linear'],
      defaultRepoSelection: ['repo-1', 'repo-2'],
      defaultLinearTeamSelection: ['team-1', 'team-2'],
      experimentalNewWorktreeCardStyle: true,
      githubProjects: {
        pinned: [],
        recent: [],
        lastViewByProject: {
          'organization:stablyai:1': { viewId: 'view-1' }
        },
        activeProject: { owner: 'stablyai', ownerType: 'organization', number: 1 }
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientSettings: vi.fn(() => settings)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('settings.update', {
        defaultTuiAgent: 'codex',
        disabledTuiAgents: ['claude', 'not-real', 'claude'],
        defaultTaskSource: 'linear',
        visibleTaskProviders: ['github', 'linear'],
        defaultTaskViewPreset: 'my-prs',
        experimentalNewWorktreeCardStyle: true,
        defaultRepoSelection: settings.defaultRepoSelection,
        defaultLinearTeamSelection: ['team-1', 'team-2'],
        githubProjects: settings.githubProjects
      })
    )

    expect(runtime.updateClientSettings).toHaveBeenCalledWith({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['claude'],
      defaultTaskSource: 'linear',
      visibleTaskProviders: ['github', 'linear'],
      defaultTaskViewPreset: 'my-prs',
      experimentalNewWorktreeCardStyle: true,
      defaultRepoSelection: settings.defaultRepoSelection,
      defaultLinearTeamSelection: ['team-1', 'team-2'],
      githubProjects: settings.githubProjects
    })
    expect(response).toMatchObject({ ok: true, result: { settings } })

    vi.mocked(runtime.updateClientSettings).mockClear()
    await dispatcher.dispatch(
      makeRequest('settings.update', {
        defaultTaskSource: 'jira',
        visibleTaskProviders: ['github', 'jira']
      })
    )

    expect(runtime.updateClientSettings).toHaveBeenCalledWith({
      defaultTaskSource: 'jira',
      visibleTaskProviders: ['github', 'jira']
    })
  })

  it('returns the runtime host persisted UI state', async () => {
    const ui: PersistedUIState = {
      ...getDefaultUIState(),
      groupBy: 'none',
      sortBy: 'smart',
      showActiveOnly: true,
      filterRepoIds: ['repo-1']
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getUIState: vi.fn(() => ui)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ui.get'))

    expect(runtime.getUIState).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({ ok: true, result: { ui } })
  })

  it('persists UI updates on the runtime host and returns the updated state', async () => {
    const updated: PersistedUIState = {
      ...getDefaultUIState(),
      rightSidebarOpen: false,
      rightSidebarTab: 'checks',
      rightSidebarExplorerView: 'search',
      showActiveOnly: true,
      hideAutomationGeneratedWorkspaces: true,
      filterRepoIds: ['repo-1']
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', {
        rightSidebarOpen: false,
        rightSidebarTab: 'checks',
        rightSidebarExplorerView: 'search',
        showActiveOnly: true,
        hideSleepingWorkspaces: true,
        hideAutomationGeneratedWorkspaces: true,
        filterRepoIds: ['repo-1']
      })
    )

    expect(runtime.updateUIState).toHaveBeenCalledWith({
      rightSidebarOpen: false,
      rightSidebarTab: 'checks',
      rightSidebarExplorerView: 'search',
      showActiveOnly: true,
      hideSleepingWorkspaces: true,
      hideAutomationGeneratedWorkspaces: true,
      filterRepoIds: ['repo-1']
    })
    expect(response).toMatchObject({ ok: true, result: { ui: updated } })
  })

  it('accepts persisted literal UI arrays and nested UI state', async () => {
    const updated: PersistedUIState = {
      ...getDefaultUIState(),
      worktreeCardProperties: ['status', 'branch', 'inline-agents'],
      _worktreeCardModeDefaulted: true,
      statusBarItems: ['codex'],
      taskResumeState: {
        githubMode: 'items',
        githubItemsQuery: 'is:open',
        githubProjectHiddenFieldIdsByView: {
          'project-1:view-1': ['field-1']
        }
      },
      workspaceCleanup: {
        dismissals: {
          'repo::/worktree': {
            worktreeId: 'repo::/worktree',
            dismissedAt: 123,
            fingerprint: 'abc',
            classifierVersion: 2
          }
        }
      },
      featureTipsSeenIds: ['voice-dictation'],
      featureInteractions: {
        tasks: { firstInteractedAt: 100, interactionCount: 2 }
      },
      contextualToursSeenIds: ['tasks'],
      contextualToursAutoEligible: true,
      usageEmptyStateDismissed: true,
      browserDefaultZoomLevel: 1.5
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const payload = {
      worktreeCardProperties: ['status', 'branch', 'inline-agents'],
      _worktreeCardModeDefaulted: true,
      statusBarItems: ['codex'],
      taskResumeState: {
        githubMode: 'items',
        githubItemsQuery: 'is:open',
        githubProjectHiddenFieldIdsByView: {
          'project-1:view-1': ['field-1']
        }
      },
      workspaceCleanup: {
        dismissals: {
          'repo::/worktree': {
            worktreeId: 'repo::/worktree',
            dismissedAt: 123,
            fingerprint: 'abc',
            classifierVersion: 2
          }
        }
      },
      featureTipsSeenIds: ['voice-dictation'],
      featureInteractions: {
        tasks: { firstInteractedAt: 100, interactionCount: 2 }
      },
      contextualToursSeenIds: ['tasks'],
      contextualToursAutoEligible: true,
      usageEmptyStateDismissed: true,
      browserDefaultZoomLevel: 1.5
    }
    const response = await dispatcher.dispatch(makeRequest('ui.set', payload))

    expect(runtime.updateUIState).toHaveBeenCalledWith({
      ...payload,
      worktreeCardProperties: ['status', 'unread', 'branch', 'inline-agents']
    })
    expect(response).toMatchObject({ ok: true, result: { ui: updated } })
  })

  it('records a feature interaction through the runtime host', async () => {
    const updated: PersistedUIState = {
      ...getDefaultUIState(),
      featureInteractions: {
        tasks: { firstInteractedAt: 100, interactionCount: 1 }
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      recordFeatureInteraction: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ui.recordFeatureInteraction', 'tasks'))

    expect(runtime.recordFeatureInteraction).toHaveBeenCalledWith('tasks')
    expect(response).toMatchObject({ ok: true, result: { ui: updated } })
  })

  it('rejects unknown and malformed UI update fields', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', { showActiveOnly: 'yes', unknownField: true })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('rejects unknown worktree card properties', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', { worktreeCardProperties: ['status', 'pr-status'] })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('rejects star-nag persisted state mutations from remote clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', {
        starNagBaselineAgents: 10,
        starNagAppVersion: '1.2.3',
        starNagAgentValueMomentAppVersion: '1.2.3',
        starNagNextThreshold: 70,
        starNagCompleted: true,
        starNagDeferredUntil: null
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('strips retired worktree card properties from legacy clients', async () => {
    const updated: PersistedUIState = {
      ...getDefaultUIState(),
      worktreeCardProperties: ['status', 'issue']
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', { worktreeCardProperties: ['status', 'unread', 'ci', 'pr', 'issue'] })
    )

    expect(runtime.updateUIState).toHaveBeenCalledWith({
      worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr']
    })
    expect(response).toMatchObject({ ok: true, result: { ui: updated } })
  })

  it('rejects each star-nag persisted state mutation field from remote clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
    const forbiddenPayloads = [
      { starNagBaselineAgents: 10 },
      { starNagAppVersion: '1.2.3' },
      { starNagAgentValueMomentAppVersion: '1.2.3' },
      { starNagNextThreshold: 70 },
      { starNagCompleted: true },
      { starNagDeferredUntil: null }
    ]

    for (const payload of forbiddenPayloads) {
      const response = await dispatcher.dispatch(makeRequest('ui.set', payload))
      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('rejects unknown feature interaction ids', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', {
        featureInteractions: {
          unknown: { firstInteractedAt: 100 }
        }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('rejects unknown feature tip ids', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', { featureTipsSeenIds: ['voice-dictation', 'unknown-tip'] })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('rejects unknown feature interaction ids for increment RPC', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      recordFeatureInteraction: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.recordFeatureInteraction', 'unknown-feature')
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.recordFeatureInteraction).not.toHaveBeenCalled()
  })
})
