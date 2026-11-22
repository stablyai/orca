import { expect, it } from 'vitest'
import { CREATE_TEST_CALLER as CALLER } from './structured-agent-session-create.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'
import {
  adoptedParams,
  fixture
} from './structured-agent-session-create-adoption-contract.test-fixture'

it('sleeps an adopted chat that never started an agent', async () => {
  expect(await fixture.rig.host.create(CALLER, await adoptedParams())).toMatchObject({ ok: true })

  expect(await fixture.rig.host.sleepWorkspace('workspace-1', true)).toEqual({
    stoppedSessionIds: [SESSION]
  })
  expect(fixture.rig.store.getRecord(SESSION)?.sleptAt).toBeDefined()
})
