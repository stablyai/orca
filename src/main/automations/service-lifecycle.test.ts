import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore, closeTestStores, testState } from '../persistence/persistence-test-harness'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { AutomationRunLaunchError } from './headless-dispatch'
import { AutomationService } from './service'
import type { Repo } from '../../shared/repo-types'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

it.each(['chat', 'terminal'] as const)(
  'durably saves an unsuccessful published %s target without a resend',
  async (kind) => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-34332-failed-target-'))
    const store = await createStore()
    try {
      store.addRepo({
        ...buildProfileStateCutoverFixture('/repo').repos[0],
        id: 'r1',
        path: '/repo'
      })
      const automation = store.createAutomation({
        name: 'Failed delivery',
        prompt: 'check',
        agentId: 'claude',
        launchSetupPatch: { surface: 'chat' },
        projectId: 'r1',
        workspaceMode: 'existing',
        workspaceId: 'r1::/repo',
        timezone: 'UTC',
        rrule: 'FREQ=DAILY',
        dtstart: 1
      })
      const published = {
        workspaceId: 'actually-created',
        sessionKind: kind,
        chatSessionId: kind === 'chat' ? 'claude_actual' : null,
        terminalSessionId: kind === 'terminal' ? 'actual-tab' : null,
        terminalPaneKey:
          kind === 'terminal' ? 'actual-tab:11111111-1111-4111-8111-111111111111' : null,
        terminalPtyId: kind === 'terminal' ? 'actual-pty' : null
      }
      const dispatch = vi.fn(async () => {
        throw new AutomationRunLaunchError(
          'Claude could not confirm delivery. Open the run.',
          published
        )
      })
      const service = new AutomationService(store, { chatDispatcher: dispatch })
      service.setWebContents({ isDestroyed: () => false, send: vi.fn() })
      service.setRendererReady()
      const failed = await service.runNow(automation.id)
      expect(failed).toMatchObject({ ...published, status: 'dispatch_failed' })
      expect(store.listAutomationRuns()[0]).toMatchObject({
        ...published,
        status: 'dispatch_failed'
      })
      expect(dispatch).toHaveBeenCalledOnce()
      service.stop()
    } finally {
      await closeTestStores()
      rmSync(testState.dir, { recursive: true, force: true })
    }
  }
)

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

describe('AutomationService', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each([undefined, 'terminal', 'chat'] as const)(
    'routes saved surface=%s independently of the Chat callback and renderer readiness',
    async (surface) => {
      const store = await createStore()
      store.addRepo(makeRepo())
      const automation = store.createAutomation({
        name: 'Surface routing',
        prompt: 'Check the repo',
        agentId: 'claude',
        projectId: 'r1',
        workspaceMode: 'existing',
        workspaceId: 'r1::/repo',
        timezone: 'UTC',
        rrule: 'FREQ=DAILY',
        dtstart: Date.now() + 86_400_000,
        ...(surface ? { launchSetupPatch: { surface } } : {})
      })
      const launch = { workspaceId: 'wt1', terminalSessionId: null }
      const chat = vi.fn(async () => ({
        ...launch,
        sessionKind: 'chat' as const,
        chatSessionId: 'claude_chat'
      }))
      const terminal = vi.fn(async () => launch)
      const send = vi.fn()
      const desktop = new AutomationService(store, { chatDispatcher: chat })
      desktop.setWebContents({ isDestroyed: () => false, send })
      desktop.start()
      expect((await desktop.runNow(automation.id)).status).toBe('skipped_unavailable')
      expect(chat).not.toHaveBeenCalled()
      desktop.setRendererReady()
      vi.setSystemTime(Date.now() + 1)
      const dispatched = await desktop.runNow(automation.id)
      expect(dispatched.error).toBeNull()
      if (surface === 'chat') {
        expect(dispatched).toMatchObject({ status: 'dispatched', chatSessionId: 'claude_chat' })
        expect(chat).toHaveBeenCalledOnce()
        expect(send).not.toHaveBeenCalled()
      } else {
        expect(dispatched.status).toBe('dispatching')
        expect(send).toHaveBeenCalledWith(
          'automations:dispatchRequested',
          expect.objectContaining({
            automation: expect.objectContaining({
              id: automation.id,
              prompt: automation.prompt,
              workspaceMode: automation.workspaceMode,
              workspaceId: automation.workspaceId,
              ...(surface ? { surface } : {})
            }),
            run: expect.objectContaining({ id: dispatched.id })
          })
        )
        expect(chat).not.toHaveBeenCalled()
      }
      desktop.stop()
      chat.mockClear()
      vi.setSystemTime(Date.now() + 1)
      const headless = new AutomationService(store, {
        allowRemoteHostScheduling: true,
        headlessDispatcher: terminal,
        chatDispatcher: chat
      })
      try {
        expect((await headless.runNow(automation.id)).status).toBe('dispatched')
        expect(chat).toHaveBeenCalledTimes(surface === 'chat' ? 1 : 0)
        expect(terminal).toHaveBeenCalledTimes(surface === 'chat' ? 0 : 1)
      } finally {
        headless.stop()
      }
    }
  )
})
