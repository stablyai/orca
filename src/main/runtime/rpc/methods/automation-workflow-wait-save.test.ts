import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AUTOMATION_METHODS } from './automations/automations'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import type { AutomationCreateInput } from '../../../../shared/automations/automation-definition'
import { removeTreeSync } from '../../../../shared/file-write/windows-transient-lock-removal'
import {
  closeTestStores,
  createStore,
  testState
} from '../../../persistence/persistence-test-harness'
import { seedBot, seedBotAutomation } from '../../../automations/bot-automation.test-fixture'
import { withPlaceRefs } from '../../../automations/bot-automation-place-refs'
import { connectorTriggers } from '../../../connector-cloud/connector-triggers'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

describe('saving a github.workflow_finished wait', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-workflow-wait-save-test-'))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'))
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('keeps a parsed run= wait through automation.create to the stored rule and the hello', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const resolve = vi.fn(async () => ({ ref: 'github:42:777', label: 'acme/web' }))
    const stub = {
      getRuntimeId: () => 'test-runtime',
      createAutomation: async (input: AutomationCreateInput) => {
        const { on } = await withPlaceRefs(resolve, bot.id, { on: input.on })
        return seedBotAutomation(store, bot, {}, { ...input, on })
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automation.create reaches only these runtime methods.
    const runtime = stub as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
    const by = Date.parse('2026-11-02T09:00:00Z')

    const response = await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'automation.create',
      params: {
        name: 'Build finished',
        prompt: 'Report the result',
        agentId: 'claude',
        bot: { botId: bot.id, runsIn: 'new', resultsTo: 'chat' },
        ...EVENT_ONLY_SCHEDULE,
        once: { by },
        on: [
          // As `--on "github.workflow_finished run=https://github.com/acme/web/actions/runs/9001"` parses.
          {
            id: 'on-run',
            source: 'github',
            event: 'workflow_finished',
            in: ['acme/web'],
            run: '9001'
          }
        ]
      }
    })

    expect(response).toMatchObject({ ok: true })
    const [saved] = store.listAutomations()
    expect(saved?.on).toEqual([
      expect.objectContaining({
        source: 'github',
        event: 'workflow_finished',
        in: ['github:42:777'],
        run: '9001'
      })
    ])
    expect(connectorTriggers(store.listAutomations())).toEqual([
      expect.objectContaining({
        automationId: saved?.id,
        event: 'workflow_finished',
        in: ['github:42:777'],
        run: '9001'
      })
    ])
  })
})
