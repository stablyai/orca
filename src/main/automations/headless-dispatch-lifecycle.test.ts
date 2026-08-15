import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/types'
import { AutomationService } from './service'
import { reconcileStaleCodexHeadlessDispatches } from './headless-dispatch-lifecycle'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

function makeRepo(): Repo {
  return {
    id: 'r1',
    path: '/repo',
    displayName: 'test',
    badgeColor: '#fff',
    addedAt: 1
  }
}

async function createAutomation(
  store: Awaited<ReturnType<typeof createStore>>,
  agentId: 'claude' | 'codex'
) {
  store.addRepo(makeRepo())
  return store.createAutomation({
    name: `${agentId} check`,
    prompt: 'Check the repo',
    agentId,
    projectId: 'r1',
    workspaceMode: 'existing',
    workspaceId: 'wt1',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-14T00:00:00Z').getTime()
  })
}

describe('headless automation dispatch lifecycle', () => {
  let nextScheduledFor = 0

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-headless-lifecycle-test-'))
    vi.useFakeTimers()
    vi.setSystemTime(0)
    nextScheduledFor = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('persists the launch deadline with the dispatched transition and records evidence', async () => {
    const store = await createStore()
    const automation = await createAutomation(store, 'codex')
    const launchReady = vi.fn((deadlineAt: number) => {
      expect(deadlineAt).toBe(1_000)
      return Promise.resolve()
    })
    const cleanup = vi.fn(async () => {})
    const service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      codexHeadlessLaunchTimeoutMs: 1_000,
      headlessDispatcher: vi.fn().mockResolvedValue({
        workspaceId: 'wt1',
        terminalSessionId: 'tab-1',
        terminalPaneKey: null,
        terminalPtyId: 'pty-1',
        launchReady,
        cleanup
      })
    })

    const run = await service.runNow(automation.id)
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
        id: run.id,
        status: 'dispatched',
        launchDeadlineAt: 1_000,
        launchEvidenceAt: 0,
        terminalPaneKey: null
      })
    )
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('does not reap a pending run while its dispatcher is still creating a terminal', async () => {
    const store = await createStore()
    const automation = await createAutomation(store, 'codex')
    let resolveLaunch!: (launch: { workspaceId: string; terminalSessionId: string }) => void
    const launch = new Promise<{ workspaceId: string; terminalSessionId: string }>((resolve) => {
      resolveLaunch = resolve
    })
    const service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      codexHeadlessLaunchTimeoutMs: 1_000,
      headlessDispatcher: vi.fn().mockReturnValue(launch)
    })

    const dispatch = service.runNow(automation.id)
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('pending')
    )
    await reconcileStaleCodexHeadlessDispatches({
      store,
      now: 10_000,
      markDispatchResult: (result) => service.markDispatchResult(result)
    })
    expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('pending')

    resolveLaunch({ workspaceId: 'wt1', terminalSessionId: 'tab-1' })
    await expect(dispatch).resolves.toMatchObject({
      status: 'dispatched',
      launchDeadlineAt: Date.now() + 1_000
    })
  })

  it('reconciles only expired Codex dispatched runs and preserves other AutomationRun states', async () => {
    const store = await createStore()
    const codex = await createAutomation(store, 'codex')
    const claude = await createAutomation(store, 'claude')
    const service = new AutomationService(store, { allowRemoteHostScheduling: true })
    const addRun = (
      automationId: string,
      status: Parameters<typeof store.updateAutomationRun>[0]['status']
    ) => {
      const automation = store.listAutomations().find((entry) => entry.id === automationId)!
      const run = store.createAutomationRun(automation, nextScheduledFor++, 'manual')
      return store.updateAutomationRun({
        runId: run.id,
        status,
        workspaceId: 'wt1',
        launchDeadlineAt: 0,
        launchEvidenceAt: null
      })
    }

    const stale = addRun(codex.id, 'dispatched')
    const states = [
      'completed',
      'dispatch_failed',
      'skipped_precheck',
      'skipped_missed',
      'skipped_unavailable',
      'skipped_needs_interactive_auth'
    ] as const
    const preserved = states.map((status) => addRun(codex.id, status))
    const claudeRun = addRun(claude.id, 'dispatched')

    await reconcileStaleCodexHeadlessDispatches({
      store,
      now: 1,
      markDispatchResult: (result) => service.markDispatchResult(result)
    })

    expect(store.listAutomationRuns(codex.id).find((run) => run.id === stale.id)?.status).toBe(
      'dispatch_failed'
    )
    for (const run of preserved) {
      expect(store.listAutomationRuns(codex.id).find((entry) => entry.id === run.id)?.status).toBe(
        run.status
      )
    }
    expect(store.listAutomationRuns(claude.id).find((run) => run.id === claudeRun.id)?.status).toBe(
      'dispatched'
    )
  })

  it('cleans an active failed launch and tolerates launch-result persistence failure', async () => {
    const store = await createStore()
    const automation = await createAutomation(store, 'codex')
    const cleanup = vi.fn(async () => {})
    let rejectLaunch!: (error: Error) => void
    const launchReady = new Promise<void>((_resolve, reject) => {
      rejectLaunch = reject
    })
    const service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      headlessDispatcher: vi.fn().mockResolvedValue({
        workspaceId: 'wt1',
        terminalSessionId: 'tab-1',
        terminalPaneKey: null,
        cleanup,
        launchReady
      })
    })

    const run = await service.runNow(automation.id)
    const update = vi.spyOn(store, 'updateAutomationRun').mockImplementation(() => {
      throw new Error('run was pruned')
    })
    rejectLaunch(new Error('launch hook failed'))
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalled()
    expect(run.status).toBe('dispatched')
  })

  it('does not write launch evidence after completion wins the terminal race', async () => {
    const store = await createStore()
    const automation = await createAutomation(store, 'codex')
    let resolveLaunchReady!: () => void
    const launchReady = new Promise<void>((resolve) => {
      resolveLaunchReady = resolve
    })
    const completion = Promise.resolve({
      status: 'completed' as const,
      outputSnapshot: {
        format: 'plain_text' as const,
        content: 'done',
        capturedAt: 0,
        truncated: false
      },
      error: null
    })
    const service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      headlessDispatcher: vi.fn().mockResolvedValue({
        workspaceId: 'wt1',
        terminalSessionId: 'tab-1',
        terminalPaneKey: 'pane-1',
        terminalPtyId: 'pty-1',
        launchReady,
        completion
      })
    })

    const run = await service.runNow(automation.id)
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('completed')
    )
    resolveLaunchReady()
    await Promise.resolve()
    expect(
      store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)
    ).toMatchObject({
      status: 'completed',
      launchEvidenceAt: null,
      outputSnapshot: expect.objectContaining({ content: 'done' })
    })
  })

  it('runs the launch cleanup when the completion observable rejects', async () => {
    const store = await createStore()
    const automation = await createAutomation(store, 'codex')
    const cleanup = vi.fn(async () => {})
    let rejectCompletion!: (error: Error) => void
    const completion = new Promise<never>((_resolve, reject) => {
      rejectCompletion = reject
    })
    const service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      headlessDispatcher: vi.fn().mockResolvedValue({
        workspaceId: 'wt1',
        terminalSessionId: 'tab-1',
        terminalPaneKey: null,
        cleanup,
        completion
      })
    })

    const run = await service.runNow(automation.id)
    rejectCompletion(new Error('terminal read failed'))

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    expect(
      store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)
    ).toMatchObject({
      status: 'dispatch_failed',
      error: 'terminal read failed'
    })
  })

  it('releases the registered cleanup when the dispatched persist throws', async () => {
    const store = await createStore()
    const automation = await createAutomation(store, 'codex')
    const cleanup = vi.fn(async () => {})
    const service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      headlessDispatcher: vi.fn().mockResolvedValue({
        workspaceId: 'wt1',
        terminalSessionId: 'tab-1',
        terminalPaneKey: null,
        cleanup
      })
    })
    const original = store.updateAutomationRun.bind(store)
    vi.spyOn(store, 'updateAutomationRun').mockImplementationOnce((result) => {
      if (result.status === 'dispatched') {
        throw new Error('Automation run not found.')
      }
      return original(result)
    })

    const run = await service.runNow(automation.id)

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(
      store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)
    ).toMatchObject({
      status: 'dispatch_failed',
      error: 'Automation run not found.'
    })
  })

  it('allows an interactive terminal identity clear on a completed run', async () => {
    const store = await createStore()
    const automation = await createAutomation(store, 'claude')
    const run = store.createAutomationRun(automation, 0, 'manual')
    const service = new AutomationService(store)

    await service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      terminalPaneKey: 'pane-1',
      terminalPtyId: 'pty-1',
      error: null
    })
    await service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    })

    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      status: 'completed',
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    })
  })
})
