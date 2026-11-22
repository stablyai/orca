import '../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { RpcDispatcher } from '../../dispatcher'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { AUTOMATION_METHODS } from './automations'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list reads only these fields.
const wait = (id: string) => ({ id, enabled: true, once: {} }) as Automation
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: claims read only these fields.
const run = (status: string, trigger: string) => ({ status, trigger }) as AutomationRun

describe('automation.list', () => {
  // A fired wait stays listed until its run finishes; it must not read as still waiting.
  it('names the waits whose one run has started', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method calls only these.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAutomationsForScope: () => ({
        automations: [
          wait('fired'),
          wait('waiting'),
          wait('skipped'),
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
          { id: 'recurring', enabled: true } as Automation
        ],
        items: []
      }),
      listAutomationRunsByAutomation: (ids: readonly string[]) => {
        expect(ids).toEqual(['fired', 'waiting', 'skipped'])
        return new Map([
          ['fired', [run('running', 'event')]],
          ['waiting', [run('completed', 'manual')]],
          ['skipped', [run('skipped_missed', 'scheduled')]]
        ])
      }
    } as unknown as OrcaRuntimeService
    const rpc = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
    const reply = await rpc.dispatch({ id: 'r1', authToken: 't', method: 'automation.list' })
    expect(reply).toMatchObject({ ok: true, result: { firedWaits: ['fired'] } })
  })
})
