import { describe, expect, it } from 'vitest'
import {
  AutomationCreate,
  AutomationUpdate
} from '../../../src/shared/rpc-contract/automation-params'
import { automationListSchema } from './automation-reply-schema'
import {
  automationCreateParams,
  automationUpdateParams,
  newAutomationDraft
} from './automation-draft'
import { automationTargets, savedAutomation } from './automation-test-fixtures'

describe('mobile automation host contracts', () => {
  it('creates enabled using real host selectors and a captured setup', () => {
    const draft = {
      ...newAutomationDraft(),
      name: 'Daily review',
      prompt: 'Review changes',
      agentId: 'codex' as const,
      setupId: 'setup-1',
      workspaceMode: 'existing' as const,
      workspaceId: 'workspace-1'
    }
    const params = AutomationCreate.parse(
      automationCreateParams(draft, automationTargets(), 'creation-1')
    )
    expect(params).toMatchObject({
      enabled: true,
      repo: 'id:repo-1',
      workspace: 'id:workspace-1',
      creationKey: 'creation-1',
      destination: { selector: { kind: 'self' } },
      runContext: {
        projectId: 'project-1',
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      }
    })
    expect(params.baseBranch).toBeUndefined()
  })
  it('edits only changed fields, preserving paused/custom/advanced and future host values', () => {
    const saved = savedAutomation()
    const original = newAutomationDraft(saved)
    const params = automationUpdateParams(
      saved.id,
      { ...original, name: 'Renamed' },
      original,
      automationTargets()
    )
    expect(AutomationUpdate.parse(params)).toMatchObject({
      id: saved.id,
      updates: { name: 'Renamed' }
    })
    expect(params.updates).toEqual({ name: 'Renamed' })
    expect(params.destination).toBeUndefined()
    expect(original).toMatchObject({
      agentId: 'codex',
      rrule: saved.rrule,
      grace: '0',
      reuseSession: true
    })
  })
  it('refuses missing or duplicate owners instead of attributing rows to this host', () => {
    const automations = [savedAutomation()]
    const item = { automationId: automations[0]!.id, selector: { kind: 'self' } }
    expect(automationListSchema.safeParse({ automations }).success).toBe(false)
    expect(automationListSchema.safeParse({ automations, items: [] }).success).toBe(false)
    expect(automationListSchema.safeParse({ automations, items: [item, item] }).success).toBe(false)
    expect(
      automationListSchema.parse({ automations, items: [item] })[0]?.automation.futureField
    ).toBe('keep me')
  })
})
