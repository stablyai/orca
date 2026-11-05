import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { AUTOMATION_METHODS } from '../../runtime/rpc/methods/automations'
import { mergeWorktree } from '../../ipc/worktree-metadata-merge'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { buildHeadlessAutomationWorktreeCreateArgs } from '../../automations/headless-workspace-create'
import { closeTestStores, createStore, testState, writeDataFile } from '../persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation } from '../../../shared/automations-types'
import type { Repo } from '../../../shared/repo-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { resolveAutomationRunTarget } from '../../automations/run-target-resolution'
import { AutomationService } from '../../automations/service'
import * as prechecks from '../../automations/precheck-runner'
import * as repoTargets from '../../../shared/automation-repo-target'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const localRow: Repo = {
  id: 'twin',
  path: '/laptop/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git'
}
const sshRow: Repo = {
  id: 'twin',
  path: '/remote/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 2,
  kind: 'git',
  connectionId: 'ssh-1'
}

function legacyAutomation(overrides: Partial<Automation> = {}): Record<string, unknown> {
  // Legacy projectId values named a repo ID without host context.
  return {
    id: 'legacy-1',
    name: 'Nightly',
    prompt: 'Run checks',
    precheck: null,
    agentId: 'codex',
    projectId: 'twin',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function seed(repos: Repo[], automation: Record<string, unknown>): void {
  writeDataFile({
    ...getDefaultPersistedState(testState.dir),
    repos,
    sshTargets: [{ id: 'ssh-1', label: 'Builder', host: 'builder', port: 22, username: 'u' }],
    automations: [automation]
  })
}

function storedAutomation(store: ReturnType<typeof createStore>): Automation {
  const automation = store.listAutomations().find((entry) => entry.id === 'legacy-1')
  if (!automation) {
    throw new Error('legacy automation missing')
  }
  return automation
}

describe('legacy automation on a repo id two hosts share', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-legacy-twin-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each([5, 50])('bounds cold and run-invalidated owner projection at scale %s', (size) => {
    const repos = Array.from({ length: size }, (_, index) => ({
      ...localRow,
      id: `repo-${index}`
    }))
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos,
      automations: Array.from({ length: size }, (_, index) =>
        legacyAutomation({
          id: `automation-${index}`,
          projectId: 'repo-0',
          runContext: null
        })
      )
    })
    const store = createStore()
    const resolve = vi.spyOn(repoTargets, 'findAutomationRepo')
    const diagnose = vi.spyOn(repoTargets, 'automationRequiresHostReselection')
    const visits = () =>
      resolve.mock.calls.reduce((count, [rows]) => count + rows.length, 0) +
      diagnose.mock.calls.reduce((count, [, rows]) => count + rows.length, 0)
    try {
      const cold = store.listAutomationsForScope()
      expect(cold.items).toHaveLength(size)
      expect(cold.items.every((item) => item.selector.kind === 'self')).toBe(true)
      expect(visits()).toBeGreaterThanOrEqual(size)
      expect(visits()).toBeLessThanOrEqual(6 * size)
      resolve.mockClear()
      diagnose.mockClear()
      expect(store.listAutomationsForScope()).toBe(cold)
      expect(visits()).toBe(0)

      const automation = cold.automations[0]!
      const run = store.createAutomationRun(automation, Date.now(), 'manual')
      store.updateAutomationRun({ runId: run.id, status: 'completed' })
      resolve.mockClear()
      diagnose.mockClear()
      const invalidated = store.listAutomationsForScope()
      expect(invalidated).not.toBe(cold)
      expect(invalidated.items).toHaveLength(size)
      expect(visits()).toBeGreaterThanOrEqual(size)
      expect(visits()).toBeLessThanOrEqual(6 * size)
      resolve.mockClear()
      diagnose.mockClear()
      expect(store.listAutomationsForScope()).toBe(invalidated)
      expect(visits()).toBe(0)
    } finally {
      resolve.mockRestore()
      diagnose.mockRestore()
    }
  })

  it('preserves explicit null contexts across an unrelated saved edit and restart', async () => {
    seed([localRow], legacyAutomation({ runContext: null, sourceContext: null }))
    let store = createStore()
    store.updateAutomation('legacy-1', { name: 'Renamed', enabled: false })
    expect(storedAutomation(store)).toMatchObject({
      runContext: null,
      sourceContext: null,
      enabled: false
    })
    await closeTestStores()
    store = createStore()
    expect(storedAutomation(store)).toMatchObject({
      runContext: null,
      sourceContext: null,
      name: 'Renamed',
      enabled: false
    })
  })

  it('does not guess a host for the record at load', () => {
    seed([localRow, sshRow], legacyAutomation())
    const store = createStore()

    expect(storedAutomation(store).runContext ?? null).toBeNull()
  })

  it.each([
    ['local row first', [localRow, sshRow]],
    ['SSH row first', [sshRow, localRow]]
  ])('refuses to run and tells the user to pick the host (%s)', (_label, repos) => {
    seed(repos, legacyAutomation({ runContext: null }))
    const store = createStore()

    const target = resolveAutomationRunTarget(store, storedAutomation(store))

    expect(target).toEqual({
      ok: false,
      error: expect.stringContaining('Open the automation and pick the host'),
      errorCode: 'legacyTwinHosts'
    })
    expect(storedAutomation(store).runContext ?? null).toBeNull()
  })

  it('captures the only host on its first run, which still launches, and keeps it', async () => {
    seed([localRow], legacyAutomation({ runContext: null }))
    const store = createStore()
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch reads only isDestroyed and send.
    service.setWebContents({ isDestroyed: () => false, send } as never)
    service.setRendererReady()

    const run = await service.runNow('legacy-1')

    expect(run.status).toBe('dispatching')
    expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.any(Object))
    const stamped = storedAutomation(store).runContext
    expect(stamped).toMatchObject({ hostId: 'local', repoId: 'twin', path: '/laptop/twin' })

    await closeTestStores()
    const reloaded = createStore()
    expect(storedAutomation(reloaded).runContext).toEqual(stamped)
  })

  it('does not capture a host from a path that only reports a refusal', async () => {
    seed([localRow], legacyAutomation({ runContext: null }))
    const store = createStore()
    const service = new AutomationService(store, { tickMs: 60_000 })

    await service.recordRefusedRun('legacy-1')

    expect(storedAutomation(store).runContext ?? null).toBeNull()
  })

  it('keeps an existing-workspace record uncaptured when capture would move its folder', async () => {
    seed(
      [localRow],
      legacyAutomation({
        runContext: null,
        workspaceMode: 'existing',
        workspaceId: 'twin::/laptop/twin-feature'
      })
    )
    const store = createStore()
    const service = new AutomationService(store, { tickMs: 60_000 })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch reads only isDestroyed and send.
    service.setWebContents({ isDestroyed: () => false, send: vi.fn() } as never)
    service.setRendererReady()

    await service.runNow('legacy-1')

    expect(storedAutomation(store).runContext ?? null).toBeNull()
    expect(resolveAutomationRunTarget(store, storedAutomation(store))).toMatchObject({
      ok: true,
      cwd: '/laptop/twin-feature'
    })
  })
  it.each(
    [false, true].flatMap((samePath) =>
      [false, true].flatMap((reversed) =>
        [false, true].map((canonical) => ({ samePath, reversed, canonical }))
      )
    )
  )(
    'keeps selected targets through runtime, storage, owner, restart and dispatch ($samePath/$reversed/$canonical)',
    async ({ samePath, reversed, canonical }) => {
      const remote = {
        ...sshRow,
        path: samePath ? localRow.path : sshRow.path,
        ...(canonical ? { connectionId: undefined, executionHostId: 'ssh:ssh-1' as const } : {})
      }
      seed(reversed ? [remote, localRow] : [localRow, remote], legacyAutomation())
      let store = createStore()
      const runtime = new OrcaRuntimeService(store)
      const setup = (hostId: string) => {
        const value = store
          .getProjectHostSetups()
          .find((entry) => entry.hostId === hostId && entry.repoId === 'twin')
        if (!value) {
          throw new Error('Missing setup')
        }
        return {
          kind: 'workspace-run' as const,
          projectId: value.projectId,
          projectHostSetupId: value.id,
          hostId: value.hostId,
          repoId: value.repoId,
          path: value.path
        }
      }
      const local = await runtime.createAutomation(
        {
          name: 'Local',
          prompt: 'Review',
          agentId: 'codex',
          repo: 'id:twin',
          runContext: setup('local'),
          rrule: '0 9 * * *',
          dtstart: 1,
          workspaceMode: 'new_per_run',
          timezone: 'UTC'
        },
        { selector: { kind: 'self' } }
      )
      const remoteContext = setup('ssh:ssh-1')
      const generation = store
        .listAutomationsForScope()
        .items.find((entry) => entry.automationId === local.id)?.selector
      expect(generation).toEqual({ kind: 'self' })
      const ssh = store.getSshTargets().find((entry) => entry.id === 'ssh-1')
      if (!ssh?.generation) {
        throw new Error('Missing registration generation')
      }
      const destination = {
        selector: { kind: 'ssh' as const, targetId: 'ssh-1', targetGeneration: ssh.generation }
      }
      const moved = await runtime.updateAutomation(
        local.id,
        { repo: 'id:twin', runContext: remoteContext },
        { expectedOwner: { selector: { kind: 'self' } }, destination }
      )
      expect(moved.runContext).toEqual(remoteContext)
      expect(store.automationOwnerPrecondition(moved.id)).toEqual(destination)
      await closeTestStores()
      store = createStore()
      const saved = store.listAutomations().find((entry) => entry.id === moved.id)
      if (!saved) {
        throw new Error('Lost automation')
      }
      const resolved = resolveAutomationRunTarget(store, saved)
      expect(resolved).toMatchObject({
        ok: true,
        cwd: remote.path,
        repo: { id: 'twin' }
      })
      if (!resolved.ok) {
        throw new Error(resolved.error)
      }
      const service = new AutomationService(store, { tickMs: 60_000 })
      const send = vi.fn()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only send/isDestroyed from this fake window.
      service.setWebContents({ isDestroyed: () => false, send } as never)
      service.setRendererReady()
      const run = await service.runNow(saved.id)
      expect(run.status).toBe('dispatching')
      expect(send).toHaveBeenCalledWith(
        'automations:dispatchRequested',
        expect.objectContaining({
          automation: expect.objectContaining({ runContext: remoteContext })
        })
      )
      expect(
        buildHeadlessAutomationWorktreeCreateArgs({ automation: saved, run, repo: resolved.repo })
          .repoSelector
      ).toEqual({ selector: 'id:twin', hostId: 'ssh:ssh-1' })
      const workspaces = [localRow, remote].map((repo) => {
        const git = {
          path: repo.path,
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        }
        return {
          ...mergeWorktree(repo.id, git, undefined),
          hostId: getRepoExecutionHostId(repo),
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null,
          git
        }
      })
      const relaunchedRuntime = new OrcaRuntimeService(store)
      Object.assign(relaunchedRuntime, {
        listResolvedWorktrees: async () => workspaces,
        hasFreshResolvedWorktreeCache: () => true
      })
      for (const repo of [localRow, remote]) {
        const hostId = getRepoExecutionHostId(repo)
        const context = setup(hostId)
        const existing = await relaunchedRuntime.createAutomation(
          {
            name: 'Existing',
            prompt: 'Review',
            agentId: 'codex',
            workspace: `id:twin::${repo.path}`,
            runContext: context,
            workspaceMode: 'existing',
            rrule: '0 9 * * *',
            dtstart: 1,
            timezone: 'UTC'
          },
          repo === localRow ? { selector: { kind: 'self' } } : destination
        )
        expect(existing.runContext).toEqual(context)
        const target = await relaunchedRuntime.showManagedTerminalWorkspace(
          `id:${existing.workspaceId}`,
          hostId
        )
        expect(target.hostId).toBe(hostId)
        expect(target.path).toBe(repo.path)
      }
    }
  )
  it.each(['captured', 'explicit null'] as const)(
    'keeps incomplete %s identity until explicit same-target adoption through RPC and reload',
    async (contextKind) => {
      const now = Date.now()
      const remote = { ...sshRow, connectionId: undefined, executionHostId: 'ssh:ssh-1' as const }
      seed([remote], legacyAutomation())
      let store = createStore()
      const setup = store.getProjectHostSetups()[0]
      const runContext = {
        kind: 'workspace-run' as const,
        projectId: setup.projectId,
        projectHostSetupId: setup.id,
        repoId: remote.id,
        hostId: setup.hostId,
        path: remote.path
      }
      const savedContext = contextKind === 'captured' ? runContext : null
      await closeTestStores()
      seed([remote], {
        ...legacyAutomation({
          runContext: savedContext,
          sourceContext: null,
          timezone: 'Pacific/Chatham',
          agentId: 'claude',
          extraAgentArgs: '--model saved',
          baseBranch: 'release',
          setupDecision: 'skip',
          missedRunGraceMinutes: 720,
          rrule: '*/1 * * * *',
          dtstart: now - 120000,
          nextRunAt: now - 60000,
          precheck: { command: 'must never run', timeoutSeconds: 1 }
        }),
        futureField: { retained: true }
      })
      store = createStore()
      store.updateSettings({
        notifications: { ...store.getSettings().notifications, enabled: false }
      })
      const settings = structuredClone(store.getSettings())
      const historical = store.createAutomationRun(
        storedAutomation(store),
        now - 86400000,
        'manual'
      )
      store.updateAutomationRun({
        runId: historical.id,
        status: 'completed',
        workspaceId: 'original-workspace',
        terminalSessionId: 'original-tab',
        terminalPaneKey: 'original-tab:original-pane',
        terminalPtyId: 'original-pty',
        outputSnapshot: {
          format: 'plain_text',
          content: 'Original output',
          capturedAt: 1,
          truncated: false
        }
      })
      const oldRun = structuredClone(store.listAutomationRuns('legacy-1')[0])
      const preserved = {
        timezone: 'Pacific/Chatham',
        sourceContext: null,
        rrule: '*/1 * * * *',
        dtstart: now - 120000,
        agentId: 'claude',
        extraAgentArgs: '--model saved',
        baseBranch: 'release',
        setupDecision: 'skip',
        precheck: { command: 'must never run', timeoutSeconds: 1 },
        missedRunGraceMinutes: 720,
        futureField: { retained: true }
      }
      const precheck = vi.spyOn(prechecks, 'runAutomationPrecheck').mockResolvedValue({
        command: 'must never run',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        error: null,
        startedAt: now,
        completedAt: now
      })
      let runtime = new OrcaRuntimeService(store)
      let dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
      let service = new AutomationService(store, { tickMs: 60000 })
      runtime.setAutomationService(service)
      const send = vi.fn()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only send/isDestroyed.
      service.setWebContents({ isDestroyed: () => false, send } as never)
      try {
        const orphan = store.automationOwnerPrecondition('legacy-1')
        expect(orphan).toMatchObject({ selector: { kind: 'orphan' } })
        expect(storedAutomation(store)).toMatchObject({
          executionTargetType: 'local',
          enabled: true
        })
        expect(storedAutomation(store).executionTargetGeneration).toBeUndefined()
        const read = await dispatcher.dispatch({
          id: 'read',
          authToken: 'test',
          method: 'automation.show',
          params: { id: 'legacy-1', expectedOwner: orphan }
        })
        expect(read).toMatchObject({ ok: true })
        const unchanged = { ...storedAutomation(store) }
        const edit = await dispatcher.dispatch({
          id: 'edit',
          authToken: 'test',
          method: 'automation.update',
          params: { id: 'legacy-1', expectedOwner: orphan, updates: { name: 'Renamed' } }
        })
        expect(edit).toMatchObject({ ok: true })
        expect(storedAutomation(store)).toMatchObject({
          executionTargetType: unchanged.executionTargetType,
          executionTargetId: unchanged.executionTargetId,
          ...preserved,
          runContext: savedContext,
          enabled: true
        })
        expect(storedAutomation(store).executionTargetGeneration).toBeUndefined()
        const manual = await service.runNow('legacy-1')
        expect(manual).toMatchObject({
          status: 'skipped_unavailable',
          error: expect.stringContaining('reselect')
        })
        service.setRendererReady()
        await vi.waitFor(() =>
          expect(
            store.listAutomationRuns('legacy-1').some((run) => run.trigger === 'scheduled')
          ).toBe(true)
        )
        const scheduled = store
          .listAutomationRuns('legacy-1')
          .find((run) => run.trigger === 'scheduled')
        if (!scheduled) {
          throw new Error('Missing due run')
        }
        expect(scheduled.status).toBe('skipped_unavailable')
        expect(await service.runPrecheck('legacy-1', scheduled.id)).toMatchObject({
          error: expect.stringContaining('reselect')
        })
        expect(send).not.toHaveBeenCalled()
        expect(precheck).not.toHaveBeenCalled()
        expect(storedAutomation(store).runContext).toEqual(savedContext)
        const paused = contextKind === 'explicit null'
        if (paused) {
          await dispatcher.dispatch({
            id: 'pause',
            authToken: 'test',
            method: 'automation.update',
            params: { id: 'legacy-1', expectedOwner: orphan, updates: { enabled: false } }
          })
        }
        service.stop()
        await closeTestStores()
        store = createStore()
        expect(storedAutomation(store)).toMatchObject({
          ...preserved,
          runContext: savedContext,
          executionTargetType: 'local',
          executionTargetId: 'local',
          enabled: !paused
        })
        expect(storedAutomation(store).executionTargetGeneration).toBeUndefined()
        expect(store.listAutomationRuns('legacy-1').find((run) => run.id === oldRun.id)).toEqual(
          oldRun
        )
        runtime = new OrcaRuntimeService(store)
        dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
        service = new AutomationService(store, { tickMs: 60000 })
        runtime.setAutomationService(service)
        expect(await service.runNow('legacy-1')).toMatchObject({
          status: 'skipped_unavailable',
          error: expect.stringContaining('reselect')
        })
        expect(precheck).not.toHaveBeenCalled()
        const target = store.getSshTargets()[0]
        const adopted = await dispatcher.dispatch({
          id: 'adopt',
          authToken: 'test',
          method: 'automation.update',
          params: {
            id: 'legacy-1',
            expectedOwner: orphan,
            updates: { repo: 'id:twin', runContext },
            destination: {
              selector: { kind: 'ssh', targetId: target.id, targetGeneration: target.generation }
            }
          }
        })
        expect(adopted).toMatchObject({ ok: true })
        expect(storedAutomation(store)).toMatchObject({
          executionTargetType: 'ssh',
          executionTargetId: target.id,
          executionTargetGeneration: target.generation,
          runContext,
          ...preserved,
          name: 'Renamed',
          enabled: !paused
        })
        expect(store.listAutomationRuns('legacy-1').find((run) => run.id === oldRun.id)).toEqual(
          oldRun
        )
        service.stop()
        await closeTestStores()
        store = createStore()
        expect(store.automationOwnerPrecondition('legacy-1')).toEqual({
          selector: { kind: 'ssh', targetId: target.id, targetGeneration: target.generation }
        })
        expect(resolveAutomationRunTarget(store, storedAutomation(store))).toMatchObject({
          ok: true,
          repo: { id: remote.id, path: remote.path, executionHostId: remote.executionHostId }
        })
        expect(storedAutomation(store)).toMatchObject({
          ...preserved,
          enabled: !paused,
          runContext
        })
        expect(store.getSettings()).toEqual(settings)
        expect(store.listAutomationRuns('legacy-1').find((run) => run.id === oldRun.id)).toEqual(
          oldRun
        )
        const reloadedService = new AutomationService(store, { tickMs: 60000 })
        const dispatch = vi.fn()
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the renderer channel is read.
        reloadedService.setWebContents({ isDestroyed: () => false, send: dispatch } as never)
        try {
          vi.useFakeTimers({ toFake: ['Date'] })
          vi.setSystemTime(now + 300000)
          reloadedService.setRendererReady()
          if (!paused) {
            await vi.waitFor(() =>
              expect(dispatch).toHaveBeenCalledWith(
                'automations:dispatchRequested',
                expect.objectContaining({
                  automation: expect.objectContaining({
                    executionTargetId: target.id,
                    executionTargetGeneration: target.generation,
                    runContext
                  }),
                  run: expect.objectContaining({ trigger: 'scheduled' })
                })
              )
            )
          }
          const manual = await reloadedService.runNow('legacy-1')
          expect(manual.status).toBe('dispatching')
          expect(dispatch).toHaveBeenCalledWith(
            'automations:dispatchRequested',
            expect.objectContaining({
              automation: expect.objectContaining({
                executionTargetId: target.id,
                executionTargetGeneration: target.generation,
                runContext
              }),
              run: expect.objectContaining({ id: manual.id, trigger: 'manual' })
            })
          )
          const checkRun = store.createAutomationRun(
            storedAutomation(store),
            now + 60000,
            'scheduled'
          )
          expect(await reloadedService.runPrecheck('legacy-1', checkRun.id)).toMatchObject({
            exitCode: 0
          })
          expect(precheck).toHaveBeenCalledWith(
            expect.objectContaining({
              target: { type: 'ssh', cwd: remote.path, connectionId: target.id }
            })
          )
          expect(storedAutomation(store).enabled).toBe(!paused)
          if (paused) {
            expect(dispatch.mock.calls).toHaveLength(1)
          }
        } finally {
          vi.useRealTimers()
          reloadedService.stop()
        }
      } finally {
        precheck.mockRestore()
        service.stop()
      }
    }
  )
})
