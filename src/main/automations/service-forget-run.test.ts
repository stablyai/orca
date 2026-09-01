// U6: owner-authorized Forget of an automation run stranded mid-flight (renderer
// died before markDispatchResult, or a headless completion promise hung). The
// run moves to dispatch_failed + agentLaunchForgottenAt, spawns/kills nothing,
// and is never re-dispatched — the only duplicate-safe escape from the state the
// plan deliberately keeps non-final.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/types'
import type { AutomationRunStatus } from '../../shared/automations-types'
import { AutomationService } from './service'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import { mintPersistedAutomationLaunchFailure } from './automation-launch-failure-stamp'

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

const REPO: Repo = { id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 }

async function seedRunInStatus(
  status: AutomationRunStatus,
  // Why: only a run the reconciler has flagged `launch_state_unknown` is
  // actually stranded (service.ts's forgetAutomationRun gate); tests that mean
  // to exercise a genuinely-stranded run opt in explicitly, so a "healthy"
  // dispatching/dispatched run (the default) stays the no-marker case.
  opts: { stranded?: boolean } = {}
): Promise<{ store: Awaited<ReturnType<typeof createStore>>; runId: string }> {
  const store = await createStore()
  store.addRepo(REPO)
  const automation = store.createAutomation({
    name: 'Nightly',
    prompt: 'Run it',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'existing',
    workspaceId: 'wt1',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime()
  })
  const run = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00').getTime())
  store.updateAutomationRun({
    runId: run.id,
    status,
    workspaceId: automation.workspaceId,
    error: null,
    ...(opts.stranded
      ? {
          agentLaunchFailure: mintPersistedAutomationLaunchFailure({ code: 'launch_state_unknown' })
        }
      : {})
  })
  return { store, runId: run.id }
}

describe('AutomationService.forgetAutomationRun (U6)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-forget-run-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('forgets a run stranded in dispatching: dispatch_failed + forgottenAt, no spawn', async () => {
    const { store, runId } = await seedRunInStatus('dispatching', { stranded: true })
    const send = vi.fn()
    const headlessDispatcher = vi.fn<HeadlessAutomationDispatcher>()
    const service = new AutomationService(store, { tickMs: 60_000, headlessDispatcher })
    service.setWebContents({ isDestroyed: () => false, send } as never)

    const forgotten = service.forgetAutomationRun(runId)

    expect(forgotten.status).toBe('dispatch_failed')
    expect(typeof forgotten.agentLaunchForgottenAt).toBe('number')
    // No spawn/kill: neither the renderer dispatch IPC nor the headless dispatcher ran.
    expect(send).not.toHaveBeenCalled()
    expect(headlessDispatcher).not.toHaveBeenCalled()
    expect(store.listAutomationRuns()[0]?.status).toBe('dispatch_failed')
  })

  it('forgets a headless run stranded in dispatched too', async () => {
    const { store, runId } = await seedRunInStatus('dispatched', { stranded: true })
    const service = new AutomationService(store, { tickMs: 60_000 })

    const forgotten = service.forgetAutomationRun(runId)

    expect(forgotten.status).toBe('dispatch_failed')
    expect(typeof forgotten.agentLaunchForgottenAt).toBe('number')
  })

  it('never re-dispatches a forgotten run — the second Forget is an idempotent no-op', async () => {
    const { store, runId } = await seedRunInStatus('dispatching', { stranded: true })
    const service = new AutomationService(store, { tickMs: 60_000 })

    const first = service.forgetAutomationRun(runId)
    const second = service.forgetAutomationRun(runId)

    expect(second.status).toBe('dispatch_failed')
    // The final run is not rewritten: the forgotten timestamp is stable.
    expect(second.agentLaunchForgottenAt).toBe(first.agentLaunchForgottenAt)
  })

  it('is a no-op on an already-settled run (its terminal outcome stands)', async () => {
    const { store, runId } = await seedRunInStatus('completed')
    const service = new AutomationService(store, { tickMs: 60_000 })

    const result = service.forgetAutomationRun(runId)

    expect(result.status).toBe('completed')
    expect(result.agentLaunchForgottenAt ?? null).toBeNull()
  })

  it('throws for an unknown run id', async () => {
    const store = await createStore()
    const service = new AutomationService(store, { tickMs: 60_000 })

    expect(() => service.forgetAutomationRun('nope')).toThrow()
  })

  // Regression for L4-M4: a non-final status alone (in particular `dispatched`,
  // which only means the terminal was confirmed created) must not be enough to
  // Forget — any authenticated remote client could otherwise force-fail a run
  // whose agent is actively working with nothing but its runId. Only the
  // reconciler's launch_state_unknown marker makes a run stranded.
  it('rejects Forget on a healthy dispatched run with no launch_state_unknown marker', async () => {
    const { store, runId } = await seedRunInStatus('dispatched')
    const service = new AutomationService(store, { tickMs: 60_000 })

    expect(() => service.forgetAutomationRun(runId)).toThrow(/not stranded/)
    expect(store.listAutomationRuns()[0]?.status).toBe('dispatched')
  })

  it('rejects Forget on a healthy dispatching run with no launch_state_unknown marker', async () => {
    const { store, runId } = await seedRunInStatus('dispatching')
    const service = new AutomationService(store, { tickMs: 60_000 })

    expect(() => service.forgetAutomationRun(runId)).toThrow(/not stranded/)
    expect(store.listAutomationRuns()[0]?.status).toBe('dispatching')
  })
})
