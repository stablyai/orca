// U6: the resolve-only agent-launch gate in AutomationService. A known launch
// failure must record dispatch_failed + the additive structured failure and
// spawn NO terminal (neither the renderer dispatch IPC nor the headless
// dispatcher runs), across both workspace modes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/types'
import type { AgentLaunchFailure } from '../../shared/agent-launch-contract'
import { AutomationService } from './service'
import type { AutomationAgentLaunchClassifier } from './automation-agent-launch-classifier'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'

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

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

// The classifier returns a PLAIN failure (ledger #12); the service mints the
// persisted wrapper at its single persist point.
const FAILURE: AgentLaunchFailure = {
  code: 'invalid_launch_snapshot',
  requestedAgent: 'custom-agent:codex:11111111-1111-4111-8111-111111111111',
  baseAgent: 'codex'
}

async function seedDueAutomation(
  workspaceMode: 'existing' | 'new_per_run'
): Promise<{ store: Awaited<ReturnType<typeof createStore>>; automationId: string }> {
  vi.setSystemTime(new Date('2026-05-13T08:59:00'))
  const store = await createStore()
  store.addRepo(makeRepo())
  const automation = store.createAutomation({
    name: 'Morning check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode,
    ...(workspaceMode === 'existing' ? { workspaceId: 'wt1' } : {}),
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime()
  })
  vi.setSystemTime(new Date('2026-05-13T09:01:00'))
  return { store, automationId: automation.id }
}

describe('AutomationService agent-launch gate (U6)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-gate-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('records dispatch_failed + structured failure and sends NO renderer dispatch', async () => {
    const { store, automationId } = await seedDueAutomation('existing')
    const send = vi.fn()
    const classifyAgentLaunch: AutomationAgentLaunchClassifier = () => FAILURE
    const service = new AutomationService(store, { tickMs: 60_000, classifyAgentLaunch })
    service.setWebContents({ isDestroyed: () => false, send } as never)

    service.start()
    service.setRendererReady()
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automationId)[0]?.status).toBe('dispatch_failed')
    )
    service.stop()

    // Zero PTY: the renderer dispatch IPC was never sent.
    expect(send).not.toHaveBeenCalledWith('automations:dispatchRequested', expect.anything())
    const run = store.listAutomationRuns(automationId)[0]
    // The host stamped the persisted wrapper (ledger #12): plain failure in,
    // host-minted failureId/version/intent/occurredAt out.
    expect(run?.agentLaunchFailure).toMatchObject({
      code: 'invalid_launch_snapshot',
      requestedAgent: 'custom-agent:codex:11111111-1111-4111-8111-111111111111',
      baseAgent: 'codex',
      version: 1,
      intent: 'automation'
    })
    expect(run?.agentLaunchFailure?.failureId).toBeTruthy()
    expect(typeof run?.agentLaunchFailure?.occurredAt).toBe('number')
    // Additive: the generic error string is retained for old readers.
    expect(run?.error).toContain('invalid_launch_snapshot')
  })

  it('gates the headless new_per_run path too — no headless dispatcher call', async () => {
    const { store, automationId } = await seedDueAutomation('new_per_run')
    const headlessDispatcher = vi.fn<HeadlessAutomationDispatcher>()
    const classifyAgentLaunch: AutomationAgentLaunchClassifier = () => FAILURE
    // No webContents / not renderer-ready → the headless path is chosen.
    const service = new AutomationService(store, {
      tickMs: 60_000,
      headlessDispatcher,
      classifyAgentLaunch
    })

    service.start()
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automationId)[0]?.status).toBe('dispatch_failed')
    )
    service.stop()

    expect(headlessDispatcher).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automationId)[0]?.agentLaunchFailure?.code).toBe(
      'invalid_launch_snapshot'
    )
  })

  it('lets a resolvable launch (null classification) dispatch normally', async () => {
    const { store, automationId } = await seedDueAutomation('existing')
    const send = vi.fn()
    const classifyAgentLaunch: AutomationAgentLaunchClassifier = () => null
    const service = new AutomationService(store, { tickMs: 60_000, classifyAgentLaunch })
    service.setWebContents({ isDestroyed: () => false, send } as never)

    service.start()
    service.setRendererReady()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.any(Object))
    )
    service.stop()

    expect(store.listAutomationRuns(automationId)[0]?.status).toBe('dispatching')
    expect(store.listAutomationRuns(automationId)[0]?.agentLaunchFailure ?? null).toBeNull()
  })
})
