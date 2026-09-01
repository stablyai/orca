import { describe, expect, it } from 'vitest'
import type { CustomTuiAgentId, GlobalSettings } from '../../shared/types'
import type { CustomAgentDraft } from '../../shared/agent-catalog-snapshot'
import {
  AgentCatalogRepairTokenRegistry,
  applyAgentCatalogMutation,
  type ApplyAgentCatalogMutationArgs
} from './agent-catalog-mutations'

function settingsWith(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    defaultTuiAgent: 'auto',
    disabledTuiAgents: [],
    customTuiAgents: [],
    deletedCustomTuiAgents: [],
    agentCatalogRevision: 5,
    agentCmdOverrides: {},
    ...overrides
  } as GlobalSettings
}

function apply(
  overrides: Partial<ApplyAgentCatalogMutationArgs> & {
    mutation: ApplyAgentCatalogMutationArgs['request']['mutation']
  }
) {
  const { mutation, ...rest } = overrides
  return applyAgentCatalogMutation({
    settings: settingsWith(),
    currentRevision: 5,
    repairTokens: new AgentCatalogRepairTokenRegistry(),
    countTombstoneReferences: () => 0,
    ...rest,
    request: { expectedRevision: 5, mutation }
  })
}

describe('draft malformed payloads', () => {
  it('returns typed errors for missing args/env instead of throwing in draftToDefinition', () => {
    const missingArgs = apply({
      mutation: {
        kind: 'create',
        baseAgent: 'codex',
        draft: {
          label: 'X',
          commandOverride: null,
          env: {},
          syncEnv: false
        } as unknown as CustomAgentDraft
      }
    })
    expect(missingArgs).toMatchObject({
      ok: false,
      code: 'invalid_agent_field',
      field: 'args',
      reason: 'bounds'
    })

    const missingEnv = apply({
      mutation: {
        kind: 'create',
        baseAgent: 'codex',
        draft: {
          label: 'X',
          commandOverride: null,
          args: '',
          syncEnv: false
        } as unknown as CustomAgentDraft
      }
    })
    expect(missingEnv).toMatchObject({
      ok: false,
      code: 'invalid_agent_field',
      field: 'env',
      reason: 'bounds'
    })
  })

  it('returns typed errors on update-custom for missing args/env too', () => {
    const id = 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd' as CustomTuiAgentId
    const live = {
      id,
      baseAgent: 'codex',
      label: 'My Codex',
      args: '',
      env: {},
      syncEnv: false
    }
    const result = apply({
      settings: settingsWith({ customTuiAgents: [live] as GlobalSettings['customTuiAgents'] }),
      mutation: {
        kind: 'update-custom',
        id,
        changes: { label: 'Renamed', commandOverride: null, syncEnv: false } as CustomAgentDraft
      }
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_agent_field',
      field: 'args',
      reason: 'bounds'
    })
  })

  it('returns a typed error for a non-string draft commandOverride', () => {
    const result = apply({
      mutation: {
        kind: 'create',
        baseAgent: 'codex',
        draft: {
          label: 'X',
          commandOverride: 42 as unknown as string,
          args: '',
          env: {},
          syncEnv: false
        }
      }
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_agent_field',
      field: 'commandOverride'
    })
  })
})
