import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Automation, AutomationCreateInput } from '../../../../shared/automations-types'
import {
  createAutomationForTarget,
  getAutomationListTarget,
  listAutomationRunsForTarget,
  listAutomationsForTarget,
  runAutomationNowForTarget,
  updateAutomationForTarget
} from './automation-host-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn()
}))

const mockApi = {
  automations: {
    list: vi.fn(),
    listRuns: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    runNow: vi.fn()
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Remote check',
    prompt: 'Check',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'remote_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    runContext: {
      kind: 'workspace-run',
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:gpu',
      projectHostSetupId: 'setup-gpu',
      repoId: 'repo-1',
      path: '/srv/orca'
    },
    ...overrides
  }
}

describe('automation host client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists automations from the active remote server when one is selected', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ automations: [makeAutomation()] })

    const target = getAutomationListTarget({ activeRuntimeEnvironmentId: 'gpu' })
    const automations = await listAutomationsForTarget(target)

    expect(automations).toHaveLength(1)
    expect(mockApi.automations.list).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'gpu' },
      'automation.list',
      undefined,
      { timeoutMs: 15_000 }
    )
  })

  it('returns an empty array when the response omits `automations` (proto3 omitempty, zero automations)', async () => {
    // Live-reproduced bug: a tenant with zero automations gets a response
    // with no `automations` key at all, not `{ automations: [] }` — crashed
    // AutomationsPage's refresh() with "Cannot read properties of undefined
    // (reading 'some')" before this fallback was added.
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({})

    const target = getAutomationListTarget({ activeRuntimeEnvironmentId: 'gpu' })
    const automations = await listAutomationsForTarget(target)

    expect(automations).toEqual([])
  })

  it('returns an empty array when the response omits `runs` (proto3 omitempty, zero runs)', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({})

    const target = getAutomationListTarget({ activeRuntimeEnvironmentId: 'gpu' })
    const runs = await listAutomationRunsForTarget(target)

    expect(runs).toEqual([])
  })

  it('creates and manually runs runtime-host automations through that server', async () => {
    const automation = makeAutomation()
    const input: AutomationCreateInput = {
      name: automation.name,
      prompt: automation.prompt,
      precheck: null,
      agentId: automation.agentId,
      runContext: automation.runContext,
      projectId: automation.projectId,
      workspaceMode: automation.workspaceMode,
      workspaceId: null,
      setupDecision: 'run',
      timezone: automation.timezone,
      rrule: automation.rrule,
      dtstart: automation.dtstart
    }
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ automation })
      .mockResolvedValueOnce({ run: { id: 'run-1', automationId: automation.id } })

    await createAutomationForTarget(input)
    await runAutomationNowForTarget(automation)

    expect(mockApi.automations.create).not.toHaveBeenCalled()
    expect(mockApi.automations.runNow).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'environment', environmentId: 'gpu' },
      'automation.create',
      expect.objectContaining({
        repo: 'repo-1',
        workspace: undefined,
        setupDecision: 'run',
        runContext: automation.runContext
      }),
      { timeoutMs: 15_000 }
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'environment', environmentId: 'gpu' },
      'automation.runNow',
      { id: automation.id },
      { timeoutMs: 15_000 }
    )
  })

  it('updates and manually runs SSH-host automations through the remote server that listed them', async () => {
    const automation = makeAutomation({
      runContext: {
        kind: 'workspace-run',
        projectId: 'github:stablyai/orca',
        hostId: 'ssh:devbox',
        projectHostSetupId: 'setup-devbox',
        repoId: 'repo-1',
        path: '/srv/orca'
      }
    })
    const sourceTarget = { kind: 'environment' as const, environmentId: 'gpu' }
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ automation: { ...automation, name: 'Updated' } })
      .mockResolvedValueOnce({ run: { id: 'run-1', automationId: automation.id } })

    await updateAutomationForTarget(automation, { name: 'Updated' }, sourceTarget)
    await runAutomationNowForTarget(automation, sourceTarget)

    expect(mockApi.automations.update).not.toHaveBeenCalled()
    expect(mockApi.automations.runNow).not.toHaveBeenCalled()
    // Why: FLAT, not { id, updates: {...} } — api-gateway's wscompat
    // automation.update decodes `id` and every field as siblings of one
    // top-level object; the nested shape silently no-oped every field but
    // `id` (FE-TASK-AUTO-002's discovered bug — see
    // automation-host-client.ts's updateAutomationForTarget comment).
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      sourceTarget,
      'automation.update',
      { id: automation.id, name: 'Updated' },
      { timeoutMs: 15_000 }
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      sourceTarget,
      'automation.runNow',
      { id: automation.id },
      { timeoutMs: 15_000 }
    )
  })

  it('synthesizes a 1-action run_agent chain from prompt/agentId when creating a runtime automation with no explicit actions', async () => {
    const automation = makeAutomation()
    const input: AutomationCreateInput = {
      name: automation.name,
      prompt: 'Summarize the PR',
      precheck: null,
      agentId: 'claude',
      runContext: automation.runContext,
      projectId: automation.projectId,
      workspaceMode: automation.workspaceMode,
      workspaceId: null,
      timezone: automation.timezone,
      rrule: automation.rrule,
      dtstart: automation.dtstart
    }
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ automation })

    await createAutomationForTarget(input)

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'gpu' },
      'automation.create',
      expect.objectContaining({
        actions: [
          {
            id: 'primary',
            type: 'run_agent',
            configJson: JSON.stringify({ prompt: 'Summarize the PR', agentId: 'claude' })
          }
        ]
      }),
      { timeoutMs: 15_000 }
    )
  })

  it('forwards explicit actions as-is (JSON-stringified config), not the prompt/agentId fallback', async () => {
    const automation = makeAutomation()
    const input: AutomationCreateInput = {
      name: automation.name,
      prompt: automation.prompt,
      precheck: null,
      agentId: automation.agentId,
      runContext: automation.runContext,
      projectId: automation.projectId,
      workspaceMode: automation.workspaceMode,
      workspaceId: null,
      timezone: automation.timezone,
      rrule: automation.rrule,
      dtstart: automation.dtstart,
      actions: [
        { id: 'a1', type: 'run_script', config: { script: 'echo hi' }, continueOnFailure: true }
      ]
    }
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ automation })

    await createAutomationForTarget(input)

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'gpu' },
      'automation.create',
      expect.objectContaining({
        actions: [
          {
            id: 'a1',
            type: 'run_script',
            configJson: JSON.stringify({ script: 'echo hi' }),
            continueOnFailure: true
          }
        ]
      }),
      { timeoutMs: 15_000 }
    )
  })

  it('omits `actions` entirely on a partial update that does not touch prompt/agentId (leaves the existing chain untouched)', async () => {
    const automation = makeAutomation()
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({
      automation: { ...automation, enabled: false }
    })

    await updateAutomationForTarget(automation, { enabled: false })

    const [, , sentParams] = vi.mocked(callRuntimeRpc).mock.calls[0]
    expect(sentParams).not.toHaveProperty('actions')
  })

  it('sends an explicit empty actions array through unchanged (clears the chain)', async () => {
    const automation = makeAutomation()
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ automation })

    await updateAutomationForTarget(automation, { actions: [] })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      expect.anything(),
      'automation.update',
      expect.objectContaining({ actions: [] }),
      { timeoutMs: 15_000 }
    )
  })

  it('synthesizes a 1-action chain on a full-form update that sends prompt+agentId together', async () => {
    const automation = makeAutomation()
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ automation })

    await updateAutomationForTarget(automation, { prompt: 'New prompt', agentId: 'claude' })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      expect.anything(),
      'automation.update',
      expect.objectContaining({
        actions: [
          {
            id: 'primary',
            type: 'run_agent',
            configJson: JSON.stringify({ prompt: 'New prompt', agentId: 'claude' })
          }
        ]
      }),
      { timeoutMs: 15_000 }
    )
  })
})
