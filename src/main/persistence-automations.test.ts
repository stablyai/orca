import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../shared/execution-host'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo
} from './persistence-test-harness'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })
  it('can clear an automation back to the project default branch', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ worktreeBaseRef: 'origin/main' }))
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      baseBranch: 'origin/release',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const updated = store.updateAutomation(automation.id, { baseBranch: null })

    expect(updated.baseBranch).toBeNull()
    store.flush()
    const persisted = readDataFile() as { automations: { baseBranch: string | null }[] }
    expect(persisted.automations[0].baseBranch).toBeNull()
  })

  it('persists session reuse only for existing-workspace automations', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const existingWorkspace = store.createAutomation({
      name: 'Digest',
      prompt: 'Summarize changes',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      reuseSession: true,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const newPerRun = store.createAutomation({
      name: 'Fresh',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      reuseSession: true,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(existingWorkspace.reuseSession).toBe(true)
    expect(newPerRun.reuseSession).toBe(false)
    expect(
      store.updateAutomation(existingWorkspace.id, { workspaceMode: 'new_per_run' }).reuseSession
    ).toBe(false)

    const persisted = readDataFile() as { automations: Record<string, unknown>[] }
    delete persisted.automations[0].reuseSession
    writeDataFile(persisted)
    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0].reuseSession).toBe(false)
  })

  it('persists setup decisions only for new-per-run automations', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const newPerRun = store.createAutomation({
      name: 'Fresh',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      setupDecision: 'run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const existing = store.createAutomation({
      name: 'Reuse',
      prompt: 'Summarize changes',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      setupDecision: 'run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(newPerRun.setupDecision).toBe('run')
    expect(existing.setupDecision).toBeUndefined()

    const skipped = store.updateAutomation(newPerRun.id, { setupDecision: 'skip' })
    const switchedToExisting = store.updateAutomation(newPerRun.id, {
      workspaceMode: 'existing',
      workspaceId: 'wt1'
    })

    expect(skipped.setupDecision).toBe('skip')
    expect(switchedToExisting.setupDecision).toBeUndefined()
    expect(
      store.updateAutomation(existing.id, { workspaceMode: 'new_per_run', setupDecision: 'run' })
        .setupDecision
    ).toBe('run')
  })

  it('treats undefined update fields as omitted, never as explicit clears', async () => {
    // The renderer forwards a Partial verbatim, so an untouched field arrives as explicit undefined
    // and must not take the `null` clear branch reserved for a real user clear.
    const store = await createStore()
    store.addRepo(makeRepo({ upstream: { owner: 'stablyai', repo: 'orca' } }))
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      baseBranch: 'origin/release',
      setupDecision: 'run',
      precheck: { command: 'pnpm lint', timeoutSeconds: 30 },
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const updated = store.updateAutomation(automation.id, {
      precheck: undefined,
      runContext: undefined,
      sourceContext: undefined,
      baseBranch: undefined,
      setupDecision: undefined
    })

    expect(updated.precheck).toEqual(automation.precheck)
    expect(updated.runContext).toEqual(automation.runContext)
    expect(updated.sourceContext).toEqual(automation.sourceContext)
    expect(updated.baseBranch).toBe('origin/release')
    expect(updated.setupDecision).toBe('run')
    // Explicit nulls still clear.
    expect(store.updateAutomation(automation.id, { baseBranch: null }).baseBranch).toBeNull()

    const existing = store.updateAutomation(automation.id, {
      workspaceMode: 'existing',
      workspaceId: 'wt1'
    })
    expect(store.updateAutomation(existing.id, { workspaceId: undefined }).workspaceId).toBe('wt1')
  })

  it('derives automation source and run contexts from the project host setup', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        upstream: { owner: 'stablyai', repo: 'orca' },
        connectionId: 'builder'
      })
    )

    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(automation.runContext).toMatchObject({
      kind: 'workspace-run',
      projectId: 'github:stablyai/orca',
      hostId: toSshExecutionHostId('builder'),
      projectHostSetupId: 'r1',
      repoId: 'r1',
      path: '/repo'
    })
    expect(automation.sourceContext).toMatchObject({
      kind: 'task-source',
      provider: 'github',
      projectId: 'github:stablyai/orca',
      hostId: toSshExecutionHostId('builder'),
      projectHostSetupId: 'r1',
      repoId: 'r1',
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    })
  })

  it('marks runtime-owned automations as remote-host scheduled', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        executionHostId: toRuntimeExecutionHostId('gpu-server'),
        upstream: { owner: 'stablyai', repo: 'orca' }
      })
    )

    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    expect(automation.schedulerOwner).toBe('remote_host_service')
    expect(automation.runContext).toMatchObject({
      hostId: toRuntimeExecutionHostId('gpu-server')
    })
  })

  it('snapshots automation contexts onto runs', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ upstream: { owner: 'stablyai', repo: 'orca' } }))
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    store.updateAutomation(automation.id, { sourceContext: null, runContext: null })

    expect(run.runContext).toEqual(automation.runContext)
    expect(run.sourceContext).toEqual(automation.sourceContext)
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      runContext: automation.runContext,
      sourceContext: automation.sourceContext
    })
  })

  it('backfills legacy automation contexts on load', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        upstream: { owner: 'stablyai', repo: 'orca' },
        connectionId: 'builder'
      })
    )
    const automation = store.createAutomation({
      name: 'Legacy nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    const persisted = readDataFile() as {
      automations: Record<string, unknown>[]
      automationRuns: Record<string, unknown>[]
    }
    delete persisted.automations[0].runContext
    delete persisted.automations[0].sourceContext
    delete persisted.automationRuns[0].runContext
    delete persisted.automationRuns[0].sourceContext
    writeDataFile(persisted)

    const reloaded = await createStore()
    const migratedAutomation = reloaded
      .listAutomations()
      .find((entry) => entry.id === automation.id)
    const migratedRun = reloaded
      .listAutomationRuns(automation.id)
      .find((entry) => entry.id === run.id)

    expect(migratedAutomation?.runContext).toMatchObject({
      kind: 'workspace-run',
      projectId: 'github:stablyai/orca',
      hostId: toSshExecutionHostId('builder'),
      projectHostSetupId: 'r1',
      repoId: 'r1',
      path: '/repo'
    })
    expect(migratedAutomation?.sourceContext).toMatchObject({
      kind: 'task-source',
      provider: 'github',
      projectId: 'github:stablyai/orca',
      hostId: toSshExecutionHostId('builder'),
      projectHostSetupId: 'r1',
      repoId: 'r1',
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    })
    expect(migratedRun?.runContext).toEqual(migratedAutomation?.runContext)
    expect(migratedRun?.sourceContext).toEqual(migratedAutomation?.sourceContext)
  })

  it('shrinks an oversized automationRuns file on load without any later mutation', async () => {
    const seed = await createStore()
    seed.addRepo(
      makeRepo({
        upstream: { owner: 'stablyai', repo: 'orca' },
        connectionId: 'builder'
      })
    )
    const automation = seed.createAutomation({
      name: 'Every minute',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    seed.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    seed.flush()

    // Why: a second load+flush settles the one-shot UI migration flags first, so they (not the prune) don't mark the store dirty.
    const warm = await createStore()
    warm.flush()

    const persisted = readDataFile() as { automationRuns: Record<string, unknown>[] }
    const template = persisted.automationRuns[0]
    persisted.automationRuns = Array.from({ length: 250 }, (_, i) => {
      const legacy: Record<string, unknown> = {
        ...template,
        id: `legacy-run-${i}`,
        // Only final runs are evictable; the real-world blowup was skipped_precheck rows.
        status: 'skipped_precheck',
        createdAt: 1_000 + i,
        scheduledFor: 1_000 + i
      }
      // Legacy files predate runNumber; backfill must run BEFORE the prune so survivors keep their true ordinals.
      delete legacy.runNumber
      return legacy
    })
    writeDataFile(persisted)

    vi.useFakeTimers()
    try {
      const reloaded = await createStore()
      expect(reloaded.listAutomationRuns(automation.id)).toHaveLength(100)

      // The load-path prune must mark state dirty on its own; nothing else here saves.
      vi.advanceTimersByTime(1000)
      await reloaded.waitForPendingWrite()
    } finally {
      vi.useRealTimers()
    }

    const healed = readDataFile() as { automationRuns: Record<string, unknown>[] }
    expect(healed.automationRuns).toHaveLength(100)
    expect(healed.automationRuns.at(-1)?.id).toBe('legacy-run-249')
    // Survivors carry their true lifetime ordinals (151..250), not restarted ones.
    expect(healed.automationRuns[0]?.runNumber).toBe(151)
    expect(healed.automationRuns.at(-1)?.runNumber).toBe(250)
  })

  it('does not strand an in-flight run whose completion lands after the retention cap', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        upstream: { owner: 'stablyai', repo: 'orca' },
        connectionId: 'builder'
      })
    )
    const automation = store.createAutomation({
      name: 'Every minute',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const base = new Date('2026-05-13T09:00:00Z').getTime()
    const inFlight = store.createAutomationRun(automation, base)
    store.updateAutomationRun({
      runId: inFlight.id,
      status: 'dispatched',
      workspaceId: null,
      error: null
    })

    // 120 later runs reach a final status while the first one is still dispatched.
    let firstCompletedId = ''
    for (let i = 1; i <= 120; i++) {
      const later = store.createAutomationRun(automation, base + i * 60_000)
      firstCompletedId ||= later.id
      store.updateAutomationRun({
        runId: later.id,
        status: 'completed',
        workspaceId: null,
        error: null
      })
    }

    // The late completion must still find its row.
    const completed = store.updateAutomationRun({
      runId: inFlight.id,
      status: 'completed',
      workspaceId: null,
      error: null
    })
    expect(completed.id).toBe(inFlight.id)

    const runs = store.listAutomationRuns(automation.id)
    expect(runs.some((run) => run.id === inFlight.id)).toBe(true)
    // Store can briefly hold cap+2: the last-created run finalizes after its creation-time prune, and the late completion lands without a prune of its own.
    expect(runs.some((run) => run.id === firstCompletedId)).toBe(false)
    expect(runs.length).toBeLessThanOrEqual(102)
  })

  it('persists automation precheck config and run results', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Conditional',
      prompt: 'Run checks',
      precheck: {
        command: 'test -f ready',
        timeoutSeconds: 30
      },
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())

    store.updateAutomationRun({
      runId: run.id,
      status: 'skipped_precheck',
      precheckResult: {
        command: 'test -f ready',
        exitCode: 1,
        timedOut: false,
        durationMs: 12,
        stdout: '',
        stderr: 'missing',
        stdoutTruncated: false,
        stderrTruncated: false,
        error: null,
        startedAt: 10,
        completedAt: 22
      },
      error: 'Precheck exited with code 1.'
    })

    expect(store.listAutomations()[0].precheck).toEqual({
      command: 'test -f ready',
      timeoutSeconds: 30
    })
    expect(store.listAutomationRuns(automation.id)[0].precheckResult).toMatchObject({
      exitCode: 1,
      stderr: 'missing'
    })
    expect(store.updateAutomation(automation.id, { precheck: null }).precheck).toBeNull()
  })

  it('numbers automation run titles per automation', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const first = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    const duplicate = store.createAutomationRun(
      automation,
      new Date('2026-05-13T09:00:00Z').getTime()
    )
    const second = store.createAutomationRun(automation, new Date('2026-05-14T09:00:00Z').getTime())

    expect(first.title).toBe('Nightly run 1')
    expect(duplicate.id).toBe(first.id)
    expect(duplicate.title).toBe('Nightly run 1')
    expect(second.title).toBe('Nightly run 2')
  })

  it('records feature interactions when automations are created or manually queued', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime(), 'scheduled')
    store.createAutomationRun(automation, new Date('2026-05-14T09:00:00Z').getTime(), 'manual')

    expect(store.getUI().featureInteractions?.['automation-created']?.interactionCount).toBe(1)
    expect(store.getUI().featureInteractions?.['automation-run']?.interactionCount).toBe(1)
    const persisted = readDataFile() as PersistedState
    expect(persisted.ui?.featureInteractions?.['automation-created']).toMatchObject({
      interactionCount: 1
    })
    expect(persisted.ui?.featureInteractions?.['automation-run']).toMatchObject({
      interactionCount: 1
    })
  })

  it('snapshots automation run workspace names for deleted-workspace history', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    store.setWorktreeMeta('wt1', { displayName: 'Nightly workspace' })
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    store.removeWorktreeMeta('wt1')

    expect(run.workspaceDisplayName).toBe('Nightly workspace')
    expect(store.listAutomationRuns(automation.id)[0].workspaceDisplayName).toBe(
      'Nightly workspace'
    )
  })

  it('backfills automation run workspace names before workspace deletion', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())

    const updatedCount = store.snapshotAutomationRunWorkspaceDisplayName('wt1', 'Deleted workspace')

    expect(updatedCount).toBe(1)
    expect(store.listAutomationRuns(automation.id)[0].workspaceDisplayName).toBe(
      'Deleted workspace'
    )
  })

  it('persists automation run output snapshots across later status updates', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'

    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      terminalPaneKey: paneKey,
      terminalPtyId: 'pty-run',
      outputSnapshot: {
        format: 'plain_text',
        content: 'Run finished',
        capturedAt: 1,
        truncated: false
      },
      error: null
    })
    store.updateAutomationRun({
      runId: run.id,
      status: 'completed',
      workspaceId: 'wt1',
      usage: null,
      error: null
    })

    const persisted = store.listAutomationRuns(automation.id)[0]
    expect(persisted.outputSnapshot).toMatchObject({
      content: 'Run finished',
      truncated: false
    })
    expect(persisted).toMatchObject({
      terminalSessionId: 'tab-1',
      terminalPaneKey: paneKey,
      terminalPtyId: 'pty-run'
    })
  })
})
