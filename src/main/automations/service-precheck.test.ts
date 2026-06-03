import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Repo } from '../../shared/types'
import { AutomationService } from './service'

const runAutomationPrecheckMock = vi.hoisted(() => vi.fn())
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

vi.mock('./precheck-runner', () => ({
  runAutomationPrecheck: runAutomationPrecheckMock
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

describe('AutomationService prechecks', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    runAutomationPrecheckMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('runs scheduled prechecks in the target repo before dispatch', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo({ path: '/repo/path' }))
    const automation = store.createAutomation({
      name: 'Conditional check',
      prompt: 'Check the repo',
      precheck: {
        command: 'test -f ready',
        timeoutSeconds: 30
      },
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, Date.now(), 'scheduled')
    const precheckResult = {
      command: 'test -f ready',
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
      startedAt: Date.now(),
      completedAt: Date.now()
    }
    runAutomationPrecheckMock.mockResolvedValue(precheckResult)
    const service = new AutomationService(store, { tickMs: 60_000 })

    const result = await service.runPrecheck(automation.id, run.id)

    expect(result).toEqual(precheckResult)
    expect(runAutomationPrecheckMock).toHaveBeenCalledWith({
      precheck: {
        command: 'test -f ready',
        timeoutSeconds: 30
      },
      target: {
        type: 'local',
        cwd: '/repo/path'
      }
    })
  })

  it('does not run prechecks for manual dispatches', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Manual check',
      prompt: 'Check the repo',
      precheck: {
        command: 'test -f ready',
        timeoutSeconds: 30
      },
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, Date.now(), 'manual')
    const service = new AutomationService(store, { tickMs: 60_000 })

    await expect(service.runPrecheck(automation.id, run.id)).resolves.toBeNull()
    expect(runAutomationPrecheckMock).not.toHaveBeenCalled()
  })
})
