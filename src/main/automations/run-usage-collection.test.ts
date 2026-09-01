import { describe, expect, it } from 'vitest'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { CustomTuiAgentId } from '../../shared/types'
import { collectAutomationRunUsage } from './run-usage-collection'

const CUSTOM = 'custom-agent:codex:44444444-4444-4444-8444-444444444444' as CustomTuiAgentId

function automation(agentId: Automation['agentId']): Automation {
  return { id: 'a1', agentId, executionTargetType: 'ssh' } as unknown as Automation
}

const run = { id: 'r1', status: 'completed' } as unknown as AutomationRun

const catalog = {
  customTuiAgents: [
    { id: CUSTOM, baseAgent: 'codex' as const, label: 'My Codex', args: '', env: {} }
  ]
}

describe('automation run usage provider', () => {
  it('attributes a Codex-based custom agent to the codex provider', async () => {
    const usage = await collectAutomationRunUsage({
      automation: automation(CUSTOM),
      run,
      claudeUsage: null,
      codexUsage: null,
      agentCatalog: catalog as never
    })
    expect(usage.provider).toBe('codex')
  })

  it('reports no provider for a custom the catalog cannot name', async () => {
    const usage = await collectAutomationRunUsage({
      automation: automation(CUSTOM),
      run,
      claudeUsage: null,
      codexUsage: null
    })
    expect(usage.provider).toBeNull()
  })

  it('still attributes a built-in agent directly', async () => {
    const usage = await collectAutomationRunUsage({
      automation: automation('claude'),
      run,
      claudeUsage: null,
      codexUsage: null
    })
    expect(usage.provider).toBe('claude')
  })
})
