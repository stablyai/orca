import { it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore, closeTestStores, testState } from '../persistence/persistence-test-harness'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { AutomationRunLaunchError } from './headless-dispatch'
import { AutomationService } from './service'

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
