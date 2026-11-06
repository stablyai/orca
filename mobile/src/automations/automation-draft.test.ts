import {
  loadAutomationTargets,
  automationSetupKey,
  workspaceMatchesSetup
} from './automation-target-inventory'
import { describe, expect, it } from 'vitest'

import { AutomationUpdate } from '../../../src/shared/rpc-contract/automation-params'
import { automationListSchema, runsPageSchema } from './automation-reply-schema'
import { mobileTuiAgentLabel } from '../tasks/mobile-tui-agents'
import {
  automationCreateParams,
  automationDraftPatch,
  automationUpdateParams,
  newAutomationDraft,
  validateAutomationDraft
} from './automation-draft'
import {
  automationClient,
  automationTargets,
  savedAutomation,
  savedRun
} from './automation-test-fixtures'

describe('mobile automation host contracts', () => {
  it('rejects changed blank grace, accepts explicit zero and preserves an untouched saved value', () => {
    const saved = savedAutomation()
    const original = newAutomationDraft(saved)
    for (const grace of ['', '  ']) {
      expect(validateAutomationDraft({ ...original, grace }, 2, saved)).toBe(
        'Missed-run grace must be zero or a positive number of minutes.'
      )
    }
    expect(validateAutomationDraft({ ...original, grace: '0' }, 2, saved)).toBeNull()
    expect(automationDraftPatch({ ...original, grace: '0' }, original)).toEqual({})
    const untouched = { ...saved, missedRunGraceMinutes: 720 }
    const draft = newAutomationDraft(untouched)
    expect(validateAutomationDraft(draft, 2, untouched)).toBeNull()
    expect(validateAutomationDraft({ ...draft, grace: '0' }, 2, untouched)).toBeNull()
    expect(
      automationUpdateParams(untouched.id, { ...draft, grace: '0' }, draft, automationTargets())
        .updates
    ).toEqual({ missedRunGraceMinutes: 0 })
    expect(
      automationUpdateParams(saved.id, { ...draft, name: 'Rename' }, draft, automationTargets())
        .updates
    ).toEqual({ name: 'Rename' })
  })
  it('keeps target host identity and expands the managed inventory past the initial range', async () => {
    const base = automationTargets().setups[0]!
    const setups = [base, { ...base, hostId: 'ssh:builder' as const }]
    const worktrees = Array.from({ length: 202 }, (_, i) => ({
      id: `repo-1::/repo/${i}`,
      repoId: 'repo-1',
      path: `/repo/${i}`,
      displayName: `Workspace ${i}`,
      hostId: 'ssh:builder'
    }))
    const port = automationClient((method, params) => {
      if (method === 'project.list') {
        return { projects: [{ id: base.projectId, displayName: 'Project' }] }
      }
      if (method === 'projectHostSetup.list') {
        return { setups }
      }
      if (method === 'repo.list') {
        return {
          repos: [
            { id: base.repoId, displayName: 'Local', path: base.path },
            { id: base.repoId, displayName: 'SSH', path: base.path, connectionId: 'builder' }
          ]
        }
      }
      if (method === 'ssh.listTargetSummaries') {
        return { targets: [{ id: 'builder', label: 'Builder', generation: 7 }] }
      }
      if (method === 'worktree.list') {
        const limit =
          params &&
          typeof params === 'object' &&
          'limit' in params &&
          typeof params.limit === 'number'
            ? params.limit
            : 200
        return {
          worktrees: worktrees.slice(0, limit),
          totalCount: worktrees.length,
          truncated: limit < worktrees.length,
          hostScope: { hostIds: ['ssh:builder'], omittedHostIds: ['local'] }
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const initial = await loadAutomationTargets(port.client)
    expect(initial.setups).toHaveLength(2)
    expect(initial.coverage).toMatchObject({
      totalCount: 202,
      truncated: true,
      hostScope: { omittedHostIds: ['local'] }
    })
    const complete = await loadAutomationTargets(port.client, initial.coverage.totalCount)
    expect(complete.workspaces).toHaveLength(202)
    const selected = complete.setups.find((setup) => setup.hostId === 'ssh:builder')!
    const draft = {
      ...newAutomationDraft(),
      name: 'SSH',
      prompt: 'Review',
      agentId: 'codex' as const,
      setupId: automationSetupKey(selected),
      workspaceMode: 'existing' as const,
      workspaceId: complete.workspaces[201]!.worktreeId
    }
    expect(automationCreateParams(draft, complete)).toMatchObject({
      runContext: { hostId: 'ssh:builder', path: '/repo' },
      workspace: 'id:repo-1::/repo/201',
      destination: { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } }
    })
  })

  it('resolves legacy inventory only from a unique repo host and never assumes local', async () => {
    const setup = automationTargets().setups[0]!
    let repos: {
      id: string
      path: string
      displayName: string
      connectionId: string | null
    }[] = [{ id: setup.repoId, path: setup.path, displayName: 'Local', connectionId: null }]
    const port = automationClient((method) => {
      if (method === 'project.list') {
        return { projects: [] }
      }
      if (method === 'projectHostSetup.list') {
        return { setups: [setup] }
      }
      if (method === 'repo.list') {
        return { repos }
      }
      if (method === 'ssh.listTargetSummaries') {
        return { targets: [] }
      }
      if (method === 'worktree.list') {
        return {
          worktrees: [
            { id: 'legacy', repoId: setup.repoId, path: setup.path, displayName: 'Legacy' }
          ],
          totalCount: 1,
          truncated: false,
          hostScope: { hostIds: ['local'], omittedHostIds: [] }
        }
      }
      throw new Error(method)
    })
    const local = await loadAutomationTargets(port.client)
    expect(local.workspaces[0]?.hostId).toBe('local')
    expect(workspaceMatchesSetup(local.workspaces[0]!, setup)).toBe(true)
    repos = [{ ...repos[0]!, connectionId: 'builder' }]
    const remote = await loadAutomationTargets(port.client)
    expect(remote.workspaces[0]?.hostId).toBe('ssh:builder')
    expect(workspaceMatchesSetup(remote.workspaces[0]!, setup)).toBe(false)
    repos.push({ ...repos[0]!, connectionId: null })
    expect((await loadAutomationTargets(port.client)).workspaces).toEqual([])
    repos = []
    expect((await loadAutomationTargets(port.client)).workspaces).toEqual([])
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
  it('keeps every row a newer host sends that this build can read, never the whole list', () => {
    const row = (id: string, fields: Record<string, unknown> = {}) => ({
      ...savedAutomation(),
      id,
      ...fields
    })
    const owner = (automationId: string, selector: unknown = { kind: 'self' }) => ({
      automationId,
      selector
    })
    const rows = automationListSchema.parse({
      automations: [
        row('known'),
        row('newer-agent', { agentId: 'future-agent' }),
        row('newer-surface', { surface: 'canvas' }),
        row('newer-mode', { workspaceMode: 'cloud_per_run' }),
        row('newer-owner'),
        row('duplicate-owner'),
        row('missing-owner')
      ],
      items: [
        owner('known'),
        owner('newer-agent'),
        { ...owner('newer-surface'), usageSummary: { lastRunAt: 'yesterday' } },
        owner('newer-mode'),
        owner('newer-owner', { kind: 'cloud' }),
        owner('duplicate-owner'),
        owner('duplicate-owner')
      ]
    })
    expect(rows.map((entry) => entry.automation.id)).toEqual([
      'known',
      'newer-agent',
      'newer-surface'
    ])
    expect(rows[2]?.item.usageSummary).toBeUndefined()
    expect(rows[0]?.automation.futureField).toBe('keep me')
    expect(mobileTuiAgentLabel(rows[1]!.automation.agentId)).toBe('future-agent')
    expect(automationListSchema.safeParse({ automations: [] }).success).toBe(false)
    const newerHost = {
      ...savedRun('newer-host'),
      runContext: { hostId: 'cloud:1', repoId: 'r', path: '/r' }
    }
    expect(
      runsPageSchema
        .parse({ runs: [savedRun(), newerHost, { id: 'unreadable' }] })
        .runs.map((run) => run.runContext?.hostId ?? run.id)
    ).toEqual(['run-old', 'cloud:1'])
  })
})
