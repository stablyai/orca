import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import {
  resolveBranchNameGenerationParams,
  resolveTextGenerationParams
} from '../text-generation/commit-message-text-generation'
import { resolveAiVaultSessionSearchGenerationParams } from './session-ai-rerank'
import type { GlobalSettings } from '../../shared/global-settings-types'

function settings(): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    defaultTuiAgent: 'codex',
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'medium', 'gpt-5.4': 'high' },
      modelOverridesByOperation: {
        commitMessage: { selectedModelByAgent: { codex: 'gpt-5.5' } },
        branchName: { selectedModelByAgent: { codex: 'gpt-5.4' } }
      }
    }
  }
}

describe('Session History AI search generation params', () => {
  it('equal auto-rename branchName params for the same settings and repo', () => {
    const current = settings()
    const repo = {
      connectionId: null,
      sourceControlAi: {
        customAgentCommand: 'repo-rename {prompt}'
      }
    }

    const search = resolveAiVaultSessionSearchGenerationParams(current, repo)
    const rename = resolveBranchNameGenerationParams(current, 'local', repo)
    const renameViaTextGeneration = resolveTextGenerationParams(
      current,
      'local',
      'branchName',
      repo
    )
    const commitMessage = resolveTextGenerationParams(current, 'local', 'commitMessage', repo)

    expect(search).toEqual(rename)
    expect(search).toEqual(renameViaTextGeneration)
    expect(search.ok && search.params.model).toBe('gpt-5.4')
    expect(commitMessage.ok && commitMessage.params.model).toBe('gpt-5.5')
  })
})
