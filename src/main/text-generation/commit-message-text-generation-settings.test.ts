import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { sourceControlAiSettingsFromLegacy } from '../../shared/source-control-ai'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveCommitMessageSettings } from './commit-message-text-generation'

function syncSourceControlAiFromLegacy(settings: GlobalSettings): void {
  settings.sourceControlAi = sourceControlAiSettingsFromLegacy(settings.commitMessageAi)
}

describe('resolveCommitMessageSettings', () => {
  it('falls back when a dynamic persisted model was not discovered', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'retired-model' },
      selectedThinkingByModel: {},
      customPrompt: 'Use Conventional Commits.',
      customAgentCommand: ''
    }
    settings.sourceControlAi = undefined

    const result = resolveCommitMessageSettings(settings)

    expect(result).toEqual({
      ok: true,
      params: {
        agentId: 'codex',
        model: 'gpt-5.5',
        thinkingLevel: 'low',
        customPrompt: 'Use Conventional Commits.',
        commandInputTemplate: '{basePrompt}\n\nUse Conventional Commits.'
      }
    })
  })

  it('falls back from stale Claude version ids to the CLI alias default', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'claude',
      selectedModelByAgent: { claude: 'claude-sonnet-4-6' },
      selectedThinkingByModel: { sonnet: 'low' },
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'claude',
        model: 'sonnet',
        thinkingLevel: 'low'
      }
    })
  })

  it("uses the user's default agent when the AI setting has no explicit agent", () => {
    const settings = getDefaultSettings('/tmp')
    settings.defaultTuiAgent = 'codex'

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'codex',
        model: 'gpt-5.5',
        thinkingLevel: 'low'
      }
    })
  })

  it('preserves dynamic persisted models that were discovered by the CLI', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'gpt-5.2' },
      discoveredModelsByAgent: {
        cursor: [
          {
            id: 'gpt-5.2',
            label: 'GPT 5.2',
            thinkingLevels: [{ id: 'xhigh', label: 'Extra High' }],
            defaultThinkingLevel: 'xhigh'
          }
        ]
      },
      selectedThinkingByModel: { 'gpt-5.2': 'xhigh' },
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'cursor',
        model: 'gpt-5.2',
        thinkingLevel: 'xhigh'
      }
    })
  })

  it('uses host-scoped discovered models for SSH worktrees', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'auto' },
      selectedModelByAgentByHost: { 'ssh:conn-1': { cursor: 'remote-only' } },
      discoveredModelsByAgent: { cursor: [{ id: 'auto', label: 'Auto' }] },
      discoveredModelsByAgentByHost: {
        'ssh:conn-1': { cursor: [{ id: 'remote-only', label: 'Remote Only' }] }
      },
      selectedThinkingByModel: {},
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings, 'ssh:conn-1')

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'cursor',
        model: 'remote-only'
      }
    })
  })

  it('falls back to the model default thinking level when a persisted level is stale', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.4-mini' },
      selectedThinkingByModel: { 'gpt-5.4-mini': 'turbo' },
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'codex',
        model: 'gpt-5.4-mini',
        thinkingLevel: 'low'
      }
    })
  })

  it('passes the per-agent command override into non-interactive planning', () => {
    const settings = getDefaultSettings('/tmp')
    settings.agentCmdOverrides.codex = 'npx codex'
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.4-mini' },
      selectedThinkingByModel: {},
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'codex',
        agentCommandOverride: 'npx codex'
      }
    })
  })

  it('falls back when persisted thinking belongs to an undiscovered dynamic model', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'gpt-5.2' },
      selectedThinkingByModel: { 'gpt-5.2': 'xhigh' },
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'cursor',
        model: 'auto'
      }
    })
  })

  it('requires a non-empty custom command for custom agents', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'custom',
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customPrompt: '',
      customAgentCommand: '   '
    }
    syncSourceControlAiFromLegacy(settings)

    expect(resolveCommitMessageSettings(settings)).toEqual({
      ok: false,
      error: 'Custom command is empty. Add one in Settings -> Git -> Source Control AI.'
    })
  })
})
