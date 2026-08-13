import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../shared/types'
import { cleanRetiredAgentReferences } from './retired-agent-settings-cleanup'

// Retired ids are gone from the TuiAgent union, so profiles are built untyped here.
function profile(overrides: Record<string, unknown>): PersistedState {
  return {
    repos: [],
    projectHostSetups: [],
    settings: {},
    ui: {},
    ...overrides
  } as unknown as PersistedState
}

describe('cleanRetiredAgentReferences', () => {
  it('leaves a profile without retired agents untouched', () => {
    const statusBarItems = ['claude', 'ports']
    const state = profile({
      settings: { defaultTuiAgent: 'claude', agentCmdOverrides: { codex: 'codex-next' } },
      ui: { statusBarItems }
    })
    expect(cleanRetiredAgentReferences(state)).toBe(false)
    expect(state.settings.defaultTuiAgent).toBe('claude')
    expect(state.settings.agentCmdOverrides).toEqual({ codex: 'codex-next' })
    // A clean list keeps its identity: nothing is rewritten just to be re-saved.
    expect(state.ui.statusBarItems).toBe(statusBarItems)
  })

  it('reports a change from a deeply nested retired agent id', () => {
    // The dirty flag propagates out of arrays and nested records, not just the
    // top level — it replaced a full JSON.stringify before/after comparison.
    const state = profile({
      repos: [
        {
          id: 'r1',
          sourceControlAi: { actionOverrides: { commitMessage: { agentId: 'claude' } } }
        },
        { id: 'r2', sourceControlAi: { actionOverrides: { commitMessage: { agentId: 'gemini' } } } }
      ]
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.repos[1].sourceControlAi?.actionOverrides?.commitMessage?.agentId).toBeNull()
    expect(state.repos[0].sourceControlAi?.actionOverrides?.commitMessage?.agentId).toBe('claude')
    expect(cleanRetiredAgentReferences(state)).toBe(false)
  })

  it('resets defaultTuiAgent so the composer does not preselect a missing agent', () => {
    const state = profile({ settings: { defaultTuiAgent: 'gemini' } })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.settings.defaultTuiAgent).toBeNull()

    // 'blank' is an explicit shell-only preference, not a retired agent.
    const blank = profile({ settings: { defaultTuiAgent: 'blank' } })
    expect(cleanRetiredAgentReferences(blank)).toBe(false)
    expect(blank.settings.defaultTuiAgent).toBe('blank')
  })

  it('drops retired keys from agent-keyed launch settings', () => {
    const state = profile({
      settings: {
        disabledTuiAgents: ['gemini', 'droid'],
        agentCmdOverrides: { gemini: '/usr/local/bin/gemini', claude: 'claude' },
        agentDefaultArgs: { gemini: '--yolo' },
        agentDefaultEnv: { gemini: { GEMINI_API_KEY: 'x' }, codex: { A: '1' } }
      }
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.settings.disabledTuiAgents).toEqual(['droid'])
    expect(state.settings.agentCmdOverrides).toEqual({ claude: 'claude' })
    expect(state.settings.agentDefaultArgs).toEqual({})
    expect(state.settings.agentDefaultEnv).toEqual({ codex: { A: '1' } })
  })

  it('clears the Source Control AI agent before it is copied into action recipes', () => {
    const state = profile({
      settings: {
        sourceControlAi: {
          agentId: 'gemini',
          selectedModelByAgent: { gemini: 'gemini-3-pro', claude: 'opus' },
          selectedModelByAgentByHost: { 'ssh:box': { gemini: 'gemini-3-pro' } },
          discoveredModelsByAgent: { gemini: [] },
          actions: {
            commitMessage: { agentId: 'gemini', commandInputTemplate: '{diff}' },
            pullRequest: { agentId: 'claude' }
          },
          launchActionDefaults: { fixCommitFailure: { agentId: 'gemini' } },
          modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { gemini: 'x' } } }
        }
      }
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    const ai = state.settings.sourceControlAi as unknown as Record<string, unknown>
    expect(ai).toEqual({
      agentId: null,
      selectedModelByAgent: { claude: 'opus' },
      selectedModelByAgentByHost: { 'ssh:box': {} },
      discoveredModelsByAgent: {},
      actions: {
        commitMessage: { agentId: null, commandInputTemplate: '{diff}' },
        pullRequest: { agentId: 'claude' }
      },
      launchActionDefaults: { fixCommitFailure: { agentId: null } },
      modelOverridesByOperation: { commitMessage: { selectedModelByAgent: {} } }
    })
  })

  it('clears the legacy commitMessageAi agent without switching the feature off', () => {
    const state = profile({
      settings: {
        commitMessageAi: { enabled: true, agentId: 'gemini', selectedModelByAgent: { gemini: 'x' } }
      }
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    // A cleared agent falls back to the default here, unlike automations.
    expect(state.settings.commitMessageAi).toEqual({
      enabled: true,
      agentId: null,
      selectedModelByAgent: {}
    })
  })

  it('drops the removed Gemini CLI OAuth toggle', () => {
    const state = profile({ settings: { geminiCliOAuthEnabled: true, terminalFontSize: 13 } })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.settings).toEqual({ terminalFontSize: 13 })
  })

  it('drops status-bar entries for providers that no longer report usage', () => {
    const state = profile({ ui: { statusBarItems: ['claude', 'gemini', 'antigravity', 'ports'] } })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.ui.statusBarItems).toEqual(['claude', 'ports'])
  })

  it('cleans repo and project-host-setup overrides', () => {
    const state = profile({
      repos: [{ sourceControlAi: { actionOverrides: { commitMessage: { agentId: 'gemini' } } } }],
      projectHostSetups: [
        { sourceControlAi: { actionOverrides: { pullRequest: { agentId: 'gemini' } } } }
      ]
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.repos[0].sourceControlAi?.actionOverrides?.commitMessage?.agentId).toBeNull()
    expect(
      state.projectHostSetups[0].sourceControlAi?.actionOverrides?.pullRequest?.agentId
    ).toBeNull()
  })

  it('disables and clears automations that still target a retired agent', () => {
    const state = profile({
      automations: [
        { id: 'a1', name: 'Gemini nightly', agentId: 'gemini', enabled: true },
        { id: 'a2', name: 'Claude hourly', agentId: 'claude', enabled: true }
      ]
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.automations).toEqual([
      { id: 'a1', name: 'Gemini nightly', agentId: null, enabled: false },
      { id: 'a2', name: 'Claude hourly', agentId: 'claude', enabled: true }
    ])
  })

  it('is sticky for already-disabled retired automations that still hold the agent id', () => {
    const state = profile({
      automations: [{ id: 'a1', agentId: 'gemini', enabled: false }]
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.automations).toEqual([{ id: 'a1', agentId: null, enabled: false }])
    expect(cleanRetiredAgentReferences(state)).toBe(false)
  })

  it('drops a retired createdWithAgent so reopening cannot seed a missing agent', () => {
    const state = profile({
      worktreeMeta: {
        wt1: { createdWithAgent: 'gemini', isPinned: true },
        wt2: { createdWithAgent: 'codex' }
      },
      folderWorkspaces: [{ id: 'fw1', createdWithAgent: 'gemini' }]
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.worktreeMeta.wt1).toEqual({ isPinned: true })
    expect(state.worktreeMeta.wt2.createdWithAgent).toBe('codex')
    expect(state.folderWorkspaces[0]).toEqual({ id: 'fw1' })
    expect(cleanRetiredAgentReferences(state)).toBe(false)
  })

  it('tolerates a profile missing every optional collection', () => {
    expect(cleanRetiredAgentReferences({} as PersistedState)).toBe(false)
  })
})
