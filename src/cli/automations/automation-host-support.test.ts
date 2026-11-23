import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime/client'
import { assertAutomationFieldsSupported } from './automation-host-support'

const BIWEEKLY = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=11;BYMINUTE=0'

function client(isRemote: boolean, capabilities: string[] = []) {
  const call = vi.fn(async () => ({ result: { capabilities } }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only isRemote and call
  return { client: { isRemote, call } as unknown as RuntimeClient, call }
}

describe('assertAutomationFieldsSupported schedule rules', () => {
  it('refuses an interval rule to a remote host without the capability', async () => {
    await expect(
      assertAutomationFieldsSupported(client(true).client, { rrule: BIWEEKLY })
    ).rejects.toThrow("This host's Orca is too old for this schedule.")
  })

  it('writes it to a remote host with the capability, and never probes the local runtime', async () => {
    const remote = client(true, ['automations.schedule-rules.v1'])
    await expect(
      assertAutomationFieldsSupported(remote.client, { rrule: BIWEEKLY })
    ).resolves.toBeUndefined()
    const local = client(false)
    await assertAutomationFieldsSupported(local.client, { rrule: BIWEEKLY })
    expect(local.call).not.toHaveBeenCalled()
  })
})
