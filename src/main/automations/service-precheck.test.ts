import {
  setSshTargetRegistryHandlers,
  setSshTargetRegistryStore,
  setSshConnectionManagerResolver
} from '../ssh/targets/ssh-target-registry'
import { SshConnectionStore } from '../ssh/connection/ssh-connection-store'
import { SshConnectionManager } from '../ssh/connection/ssh-connection-manager'
import {
  recordSshCredentialDeclined,
  resetSshCredentialDeclinesForTests
} from '../ssh/ssh-credential-decline'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson,
  writePersistedStateJson,
  createStore as createFreshStore,
  testState
} from '../persistence/persistence-test-harness'
import { resetRetirementCollisionKeyCacheForTests } from '../worktree-name-retirement'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import { AutomationService } from './service'
import { runHeadlessAutomationDispatch } from './headless-dispatch-runner'
import { createAutomationRunWriter } from './automation-run-writer'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type * as PrecheckRunner from './precheck-runner'

const runAutomationPrecheckMock = vi.hoisted(() => vi.fn())
let hasCreatedStoreInCase = false

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

vi.mock('./precheck-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof PrecheckRunner>()),
  runAutomationPrecheck: runAutomationPrecheckMock
}))

async function createStore() {
  if (!hasCreatedStoreInCase) {
    hasCreatedStoreInCase = true
    return createFreshStore()
  }
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

/** Inject persisted drift that normal creation would resolve. */
function mutateDataFile(
  mutate: (state: {
    automations: Record<string, unknown>[]
    automationRuns: Record<string, unknown>[]
  }) => void
): void {
  const file = join(testState.dir, 'orca-data.json')
  const state = JSON.parse(readPersistedStateJson(file))
  mutate(state)
  writePersistedStateJson(file, JSON.stringify(state))
}

describe('AutomationService prechecks', () => {
  beforeEach(() => {
    setSshTargetRegistryHandlers({
      connect: null,
      getState: () => ({
        targetId: 'ssh-test',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
    })
    setSshTargetRegistryStore(null)
    setSshConnectionManagerResolver(() => null)
    resetSshCredentialDeclinesForTests()
    hasCreatedStoreInCase = false
    resetRetirementCollisionKeyCacheForTests()
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    runAutomationPrecheckMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    setSshTargetRegistryHandlers({ connect: null, getState: null })
    setSshTargetRegistryStore(null)
    setSshConnectionManagerResolver(() => null)
    resetSshCredentialDeclinesForTests()
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('does not run scheduled prechecks when the selected host setup is stale', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo({ path: '/repo/current' }))
    const setup = store.getProjectHostSetups()[0]!
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
    const staleRunContext = {
      kind: 'workspace-run',
      projectId: setup.projectId,
      hostId: setup.hostId,
      projectHostSetupId: setup.id,
      repoId: setup.repoId,
      path: '/repo/old'
    }
    mutateDataFile((state) => {
      state.automations[0].runContext = staleRunContext
      state.automationRuns[0].runContext = staleRunContext
    })
    const reloaded = await createStore()
    const service = new AutomationService(reloaded, { tickMs: 60_000 })

    const result = await service.runPrecheck(automation.id, run.id)

    expect(result).toMatchObject({
      command: 'test -f ready',
      exitCode: null,
      error: 'Project path for the selected automation host has changed.'
    })
    expect(runAutomationPrecheckMock).not.toHaveBeenCalled()
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

  it('honors scheduled prechecks before headless dispatch', async () => {
    vi.setSystemTime(new Date('2026-05-12T08:59:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Conditional remote check',
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
      dtstart: new Date('2026-05-12T00:00:00Z').getTime()
    })
    runAutomationPrecheckMock.mockResolvedValue({
      command: 'test -f ready',
      exitCode: 1,
      timedOut: false,
      durationMs: 5,
      stdout: '',
      stderr: 'missing',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
      startedAt: Date.now(),
      completedAt: Date.now()
    })
    const headlessDispatcher = vi.fn()
    const service = new AutomationService(store, {
      tickMs: 60_000,
      allowRemoteHostScheduling: true,
      headlessDispatcher
    })
    const run = store.createAutomationRun(automation, Date.now(), 'scheduled')

    await runHeadlessAutomationDispatch({
      automation,
      run,
      target: { ok: true, cwd: '/repo', repo: store.getRepo('r1')! },
      dispatcher: headlessDispatcher,
      runs: createAutomationRunWriter(store, null),
      runPrecheck: () => service.runPrecheck(automation.id, run.id),
      markDispatchResult: (result) => service.markDispatchResult(result),
      watchRun: () => {}
    })

    expect(headlessDispatcher).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      status: 'skipped_precheck',
      error: 'Precheck exited with code 1.'
    })
  })

  it('holds a Run Now behind a scheduled headless run that is still in its precheck', async () => {
    vi.setSystemTime(new Date('2026-05-12T08:59:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Reused session',
      prompt: 'Check the repo',
      precheck: { command: 'test -f ready', timeoutSeconds: 30 },
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00Z').getTime()
    })
    let passPrecheck = (): void => {}
    runAutomationPrecheckMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          passPrecheck = () =>
            resolve({
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
            })
        })
    )
    const dispatched: string[] = []
    const service = new AutomationService(store, {
      tickMs: 60_000,
      allowRemoteHostScheduling: true,
      headlessDispatcher: async ({ run }) => {
        dispatched.push(run.trigger)
        return { workspaceId: 'wt-1', terminalSessionId: null }
      }
    })
    vi.setSystemTime(automation.nextRunAt + 30_000)
    service.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(runAutomationPrecheckMock).toHaveBeenCalledTimes(1)

    const manual = service.runNow(automation.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(dispatched).toEqual([])

    passPrecheck()
    await manual
    expect(dispatched).toEqual(['scheduled', 'manual'])
    service.stop()
  })
  it.each(['connect', 'declined', 'passphrase', 'cached', 'unavailable', 'replaced'] as const)(
    'runs SSH no-prompt preflight before precheck: %s',
    async (mode) => {
      vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
      const store = await createStore()
      store.addSshTarget({
        id: 'ssh-test',
        label: 'Build',
        host: 'host',
        port: 22,
        username: 'test',
        generation: 1,
        lastRequiredPassphrase: mode === 'passphrase' || mode === 'cached'
      })
      setSshTargetRegistryStore(new SshConnectionStore(store))
      const manager = new SshConnectionManager({ onStateChange: vi.fn() })
      vi.spyOn(manager, 'hasCachedCredential').mockReturnValue(mode === 'cached')
      setSshConnectionManagerResolver(() => manager)
      vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
      store.addRepo(makeRepo({ connectionId: 'ssh-test' }))
      const automation = store.createAutomation({
        name: 'SSH',
        prompt: 'Check',
        agentId: 'claude',
        projectId: 'r1',
        workspaceMode: 'existing',
        workspaceId: 'r1::/repo',
        reuseSession: true,
        timezone: 'UTC',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: Date.parse('2026-05-13T00:00:00Z'),
        precheck: { command: 'true', timeoutSeconds: 30 }
      })
      let connected = false
      const order: string[] = []
      const connect = vi.fn(async (_id: string, options?: { automatic?: boolean }) => {
        expect(options).toEqual({ automatic: true, interactive: false })
        order.push('connect')
        if (mode === 'unavailable') {
          throw new Error('connection lost')
        }
        connected = true
        if (mode === 'replaced') {
          store.updateAutomation(automation.id, { prompt: 'Changed' })
        }
        return {
          targetId: 'ssh-test',
          status: 'connected' as const,
          error: null,
          reconnectAttempt: 0
        }
      })
      setSshTargetRegistryHandlers({
        connect,
        getState: () => ({
          targetId: 'ssh-test',
          status: connected ? 'connected' : 'disconnected',
          error: null,
          reconnectAttempt: 0
        })
      })
      if (mode === 'declined') {
        recordSshCredentialDeclined('ssh-test')
      }
      runAutomationPrecheckMock.mockImplementation(async () => {
        order.push('precheck')
        return null
      })
      const send = vi.fn(async () => {
        order.push('send')
        return { workspaceId: 'wt1', terminalSessionId: 'tab' }
      })
      const service = new AutomationService(store, {
        allowRemoteHostScheduling: true,
        headlessDispatcher: send
      })
      const rendererSend = vi.fn()
      service.setWebContents({ isDestroyed: () => false, send: rendererSend })
      vi.setSystemTime(automation.nextRunAt)
      service.setRendererReady()
      try {
        const credentialNeeded = mode === 'declined' || mode === 'passphrase'
        const delivered = mode === 'connect' || mode === 'cached'
        const expected = credentialNeeded
          ? 'skipped_needs_interactive_auth'
          : delivered
            ? 'dispatched'
            : 'skipped_unavailable'
        await vi.waitFor(() =>
          expect(store.listAutomationRuns(automation.id)[0]?.status).toBe(expected)
        )
        expect(rendererSend).not.toHaveBeenCalled()
        if (delivered) {
          expect(order).toEqual(['connect', 'precheck', 'send'])
        } else {
          expect(runAutomationPrecheckMock).not.toHaveBeenCalled()
          expect(send).not.toHaveBeenCalled()
        }
        if (credentialNeeded) {
          expect(connect).not.toHaveBeenCalled()
        }
      } finally {
        service.stop()
      }
    }
  )
})
