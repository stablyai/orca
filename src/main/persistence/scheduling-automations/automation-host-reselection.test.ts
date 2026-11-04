import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { Automation, AutomationUpdateInput } from '../../../shared/automations-types'
import type { Repo } from '../../../shared/repo-types'
import {
  createAutomation,
  updateAutomation,
  type AutomationDefinitionOperations
} from './automation-definition-operations'
import { automationOwnerPrecondition } from './automation-owner-projection'

const destination = { selector: { kind: 'ssh', targetId: 'box', targetGeneration: 7 } } as const
const expectedOwner = { selector: { kind: 'orphan' } } as const

function fixture() {
  const repo: Repo = {
    id: 'repo',
    path: '/captured',
    displayName: 'App',
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'ssh:box'
  }
  const state = getDefaultPersistedState('/tmp/pr31617-reselection')
  state.repos = [repo]
  state.projectHostSetups = [
    {
      id: 'saved-setup',
      repoId: repo.id,
      projectId: 'logical-project',
      hostId: 'ssh:box',
      path: repo.path,
      displayName: 'App',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
  ]
  state.sshTargets = [
    { id: 'box', label: 'Box', host: 'example.test', port: 22, username: 'test', generation: 7 }
  ]
  const operations: AutomationDefinitionOperations = {
    state,
    storageAuthority: 'desktop',
    flush: vi.fn(),
    recordCreated: vi.fn()
  }
  const created = createAutomation(operations, {
    name: 'Saved',
    prompt: 'Run checks',
    agentId: 'codex',
    projectId: repo.id,
    workspaceMode: 'new_per_run',
    baseBranch: 'saved/base',
    setupDecision: 'run',
    extraAgentArgs: '--model saved',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1
  })
  const current: Automation = {
    ...created,
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service'
  }
  delete current.executionTargetGeneration
  Object.assign(current, { futureSavedValue: { keep: true } })
  Object.assign(current.runContext!, { futureContextValue: 'keep' })
  state.automations = [current]
  state.automationRuns = [
    {
      id: 'saved-run',
      automationId: current.id,
      title: 'Saved result',
      scheduledFor: 1,
      status: 'completed',
      trigger: 'manual',
      workspaceId: null,
      sessionKind: 'terminal',
      chatSessionId: null,
      terminalSessionId: 'saved-session',
      terminalPaneKey: 'saved-pane',
      terminalPtyId: 'saved-pty',
      outputSnapshot: {
        format: 'plain_text',
        content: 'Original output',
        capturedAt: 2,
        truncated: false
      },
      precheckResult: null,
      usage: null,
      error: null,
      startedAt: 1,
      dispatchedAt: 1,
      createdAt: 1
    }
  ]
  const history = state.automationRuns
  operations.flush = vi.fn()
  return { operations, state, current, repo, history }
}

describe('same-record host reselection transaction', () => {
  it.each(['absent', 'null', 'distinct'] as const)(
    'retains %s source context and all unrelated saved values',
    (source) => {
      const { operations, state, current, repo, history } = fixture()
      if (source === 'absent') {
        delete current.sourceContext
      }
      if (source === 'null') {
        current.sourceContext = null
      }
      if (source === 'distinct') {
        current.sourceContext = {
          kind: 'task-source',
          provider: 'github',
          projectId: 'saved-source',
          hostId: 'ssh:box',
          accountLabel: 'old account'
        }
      }
      Object.assign(current.sourceContext ?? {}, { futureSourceValue: 'keep' })
      const before = structuredClone(current)
      const beforeHistory = structuredClone(history)
      const updated = updateAutomation(
        operations,
        current.id,
        {
          projectId: repo.id,
          workspaceMode: current.workspaceMode,
          workspaceId: current.workspaceId,
          runContext: current.runContext,
          name: 'Renamed'
        },
        { destination, expectedOwner, resolvedRepo: repo }
      )
      expect(updated).toEqual({
        ...before,
        name: 'Renamed',
        executionTargetType: 'ssh',
        executionTargetId: 'box',
        executionTargetGeneration: 7,
        schedulerOwner: 'ssh_bridge',
        updatedAt: updated.updatedAt
      })
      expect(Object.hasOwn(updated, 'sourceContext')).toBe(source !== 'absent')
      expect(updated.runContext).toBe(current.runContext)
      expect(updated.sourceContext).toBe(current.sourceContext)
      expect(state.automations).toHaveLength(1)
      expect(state.automationRuns).toBe(history)
      expect(state.automationRuns).toEqual(beforeHistory)
      expect(operations.flush).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    'missing-setup',
    'duplicate-setup',
    'stale-path',
    'other-host',
    'duplicate-repo',
    'stale-generation'
  ])('refuses %s before mutation', (kind) => {
    const { operations, state, current, repo } = fixture()
    if (kind === 'missing-setup') {
      state.projectHostSetups = []
    }
    if (kind === 'duplicate-setup') {
      state.projectHostSetups.push({ ...state.projectHostSetups[0] })
    }
    if (kind === 'stale-path') {
      state.projectHostSetups[0].path = '/changed'
    }
    if (kind === 'other-host') {
      state.repos = [{ ...repo, executionHostId: 'ssh:other' }]
    }
    if (kind === 'duplicate-repo') {
      state.repos.push({ ...repo })
    }
    if (kind === 'stale-generation') {
      state.sshTargets[0].generation = 8
    }
    const before = structuredClone(state)
    expect(() =>
      updateAutomation(
        operations,
        current.id,
        { projectId: repo.id, runContext: current.runContext },
        { destination, expectedOwner, resolvedRepo: repo }
      )
    ).toThrow()
    expect(state).toEqual(before)
    expect(operations.flush).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'allows name-only edits with no discovery catalog (enabled=%s)',
    (enabled) => {
      const { operations, state, current } = fixture()
      current.enabled = enabled
      state.projectHostSetups = []
      const before = structuredClone(current)
      const updated = updateAutomation(
        operations,
        current.id,
        { name: 'Renamed' },
        { expectedOwner }
      )
      expect(updated).toEqual({ ...before, name: 'Renamed', updatedAt: updated.updatedAt })
      expect(automationOwnerPrecondition(state, 'desktop', current.id)).toEqual(expectedOwner)
    }
  )

  it('does not silently discard an actual changed target', () => {
    const { operations, state, current, repo } = fixture()
    const updates: AutomationUpdateInput = {
      runContext: { ...current.runContext!, path: '/changed' },
      projectId: repo.id
    }
    expect(() =>
      updateAutomation(operations, current.id, updates, { destination, expectedOwner })
    ).toThrow()
    expect(state.automations[0]).toBe(current)
    expect(operations.flush).not.toHaveBeenCalled()
  })

  it('uses ordinary update semantics for an explicitly changed source context', () => {
    const { operations, current, repo } = fixture()
    const sourceContext = {
      kind: 'task-source',
      provider: 'github',
      projectId: 'changed-source',
      hostId: 'ssh:box'
    } as const
    const updated = updateAutomation(
      operations,
      current.id,
      { projectId: repo.id, runContext: current.runContext, sourceContext },
      { destination, expectedOwner, resolvedRepo: repo }
    )
    expect(updated.sourceContext).toEqual(sourceContext)
    expect(operations.flush).toHaveBeenCalledTimes(1)
  })

  it('retains an explicit source clear when the saved source context is absent', () => {
    const { operations, current, repo, state, history } = fixture()
    delete current.sourceContext
    const updated = updateAutomation(
      operations,
      current.id,
      {
        projectId: repo.id,
        runContext: current.runContext,
        sourceContext: null
      },
      { destination, expectedOwner, resolvedRepo: repo }
    )
    expect(Object.hasOwn(updated, 'sourceContext')).toBe(true)
    expect(updated.sourceContext).toBeNull()
    expect(updated.runContext).toEqual({
      kind: 'workspace-run',
      projectId: 'logical-project',
      hostId: 'ssh:box',
      projectHostSetupId: 'saved-setup',
      repoId: repo.id,
      path: repo.path
    })
    expect(updated).toMatchObject({
      id: current.id,
      executionTargetType: 'ssh',
      executionTargetId: 'box',
      executionTargetGeneration: 7,
      schedulerOwner: 'ssh_bridge'
    })
    expect(state.automationRuns).toBe(history)
    expect(state.automations).toEqual([updated])
    expect(operations.flush).toHaveBeenCalledTimes(1)
  })
})
