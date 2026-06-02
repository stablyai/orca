import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Repo } from '../../shared/types'
import { AutomationService } from './service'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../git/repo', () => ({
  getGitUsername: vi.fn().mockReturnValue('testuser')
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

describe('AutomationService app launch runs', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-launch-test-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('dispatches app-launch automations once when the renderer becomes ready', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Start dev server',
      prompt: '',
      action: 'terminal_command',
      command: 'pnpm dev',
      trigger: 'app_launch',
      launchTarget: 'main_and_open_worktrees',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const initialNextRunAt = automation.nextRunAt
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({
      isDestroyed: () => false,
      send
    } as never)

    service.setRendererReady()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.any(Object))
    )
    service.setRendererReady()
    await vi.runOnlyPendingTimersAsync()

    expect(send).toHaveBeenCalledTimes(1)
    const [, payload] = send.mock.calls[0]
    expect(payload.automation.id).toBe(automation.id)
    expect(payload.run.trigger).toBe('app_launch')
    expect(payload.run.status).toBe('dispatching')
    expect(store.listAutomations().find((entry) => entry.id === automation.id)?.nextRunAt).toBe(
      initialNextRunAt
    )
  })

  it('dispatches app-launch agent automations', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Remember context',
      prompt: 'Summarize yesterday',
      action: 'agent_prompt',
      trigger: 'app_launch',
      agentId: 'codex',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({
      isDestroyed: () => false,
      send
    } as never)

    service.setRendererReady()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.any(Object))
    )

    const [, payload] = send.mock.calls[0]
    expect(payload.automation.id).toBe(automation.id)
    expect(payload.automation.action).toBe('agent_prompt')
    expect(payload.run.trigger).toBe('app_launch')
  })

  it('dispatches global app-launch terminal commands without a project repo', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    const automation = store.createAutomation({
      name: 'Start agentmemory',
      prompt: '',
      action: 'terminal_command',
      command: 'agentmemory',
      trigger: 'app_launch',
      scope: 'global',
      globalCwd: '/Users/me/agentmemory',
      agentId: 'claude',
      projectId: '',
      workspaceMode: 'existing',
      workspaceId: null,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({
      isDestroyed: () => false,
      send
    } as never)

    service.setRendererReady()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.any(Object))
    )

    const [, payload] = send.mock.calls[0]
    expect(payload.automation.id).toBe(automation.id)
    expect(payload.automation.scope).toBe('global')
    expect(payload.automation.globalCwd).toBe('/Users/me/agentmemory')
    expect(payload.run.trigger).toBe('app_launch')
  })
})
