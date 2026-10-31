import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { Automation } from '../../shared/automations-types'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { Store } from '../persistence'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import type * as UncGate from '../wsl/wsl-unc-access-gate'
import { AutomationService } from './service'

const blocked = vi.hoisted(() =>
  vi.fn(
    async (
      _path: string,
      _wslDistro?: string | null
    ): Promise<{ distro: string; state: 'stopped' } | null> => null
  )
)
const projectGit = vi.hoisted(() => {
  const value: { wslDistro?: string } = {}
  return value
})
vi.mock('../project-runtime-git-options', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLocalProjectWorktreeGitOptions: () =>
    projectGit.wslDistro ? { wslDistro: projectGit.wslDistro } : {}
}))
vi.mock('../wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof UncGate>()),
  blockedWslDistroForPath: blocked
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const REPO_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
const STOPPED_COPY =
  'The WSL distro Ubuntu is stopped, so this scheduled run did not start it. Start the distro or use Run now; later runs go ahead while it runs.'

function seedAutomation(store: Store, path = REPO_PATH): Automation {
  const repo: Repo = {
    id: 'r1',
    path,
    displayName: 'test',
    badgeColor: '#fff',
    addedAt: 1
  }
  store.addRepo(repo)
  return store.createAutomation({
    name: 'Nightly check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime()
  })
}

function attachedService(store: Store, send = vi.fn()): AutomationService {
  const service = new AutomationService(store, { tickMs: 60_000, onAutomationsChanged: vi.fn() })
  service.setWebContents({ isDestroyed: () => false, send })
  return service
}

async function evaluateAt(store: Store, service: AutomationService, id: string, when: string) {
  const nextRunAt = (): number | undefined =>
    store.listAutomations().find((entry) => entry.id === id)?.nextRunAt
  const before = nextRunAt()
  vi.setSystemTime(new Date(when))
  await vi.waitFor(() => {
    service.setRendererReady()
    expect(nextRunAt()).toBeGreaterThan(before ?? 0)
  })
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-wsl-stopped-'))
  blocked.mockReset()
  blocked.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
  projectGit.wslDistro = undefined
  vi.useFakeTimers()
})
afterEach(async () => {
  await closeTestStores()
  vi.useRealTimers()
  removeTreeSync(testState.dir)
})

describe('a scheduled automation on a stopped WSL distro (E9)', () => {
  it('skips the run with a retryable reason instead of starting the distro', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedAutomation(store)
    const send = vi.fn()
    const service = attachedService(store, send)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')
    await evaluateAt(store, service, automation.id, '2026-05-14T09:01:00')

    // Repeated stopped ticks fold into one skip, and nothing reached the window.
    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: STOPPED_COPY,
      errorCode: 'wslDistroStopped',
      errorParams: { distro: 'Ubuntu' }
    })
    expect(send).not.toHaveBeenCalled()
    expect(blocked).toHaveBeenCalledWith(REPO_PATH, undefined)
  })

  it("leaves Run now alone: it is the user's act and may start the distro", async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedAutomation(store)
    const send = vi.fn()
    const service = attachedService(store, send)
    service.setRendererReady()

    await service.runNow(automation.id)

    expect(send).toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)[0]?.errorCode).toBeUndefined()
  })

  it("gates a host-path project whose Git runs in WSL, by the project's distro", async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    projectGit.wslDistro = 'Ubuntu'
    blocked.mockImplementation(async (_path, wslDistro) =>
      wslDistro ? { distro: wslDistro, state: 'stopped' } : null
    )
    const store = await createStore()
    const automation = seedAutomation(store, 'C:\\repo')
    const send = vi.fn()
    const service = attachedService(store, send)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')

    expect(blocked).toHaveBeenCalledWith('C:\\repo', 'Ubuntu')
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      status: 'skipped_unavailable',
      errorCode: 'wslDistroStopped'
    })
    expect(send).not.toHaveBeenCalled()
  })
})
