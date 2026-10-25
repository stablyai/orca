import { afterEach, expect, it, vi } from 'vitest'
import { recordingStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  hostTestAttachParams,
  HOST_TEST_SESSION as SESSION
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { commitStructuredAgentSessionCreate } from './structured-agent-session-create'

let rig: RestTestRig
afterEach(async () => rig.dispose())
it('keeps a failed early tab publication unconfirmed on the original receipt without starting a provider', async () => {
  const log = recordingStructuredAgentSessionLogger()
  rig = await createRestTestRig({ logger: log.logger })
  const failure = new Error('tab write failed')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commit reaches only the tab publication on the runtime.
  const runtime = {
    publishStructuredAgentSessionTab: vi.fn(async () => {
      throw failure
    })
  } as unknown as OrcaRuntimeService
  const params = hostTestAttachParams(null)
  const input = {
    runtime,
    caller: { callerKey: 'client-1' },
    prepared: {
      host: rig.host,
      attachParams: params,
      tab: { workspaceId: 'workspace-1', agent: 'codex' as const }
    },
    activate: true
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await commitStructuredAgentSessionCreate(input)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', details: { reason: 'tabUnconfirmed' } }
    })
  }
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(
    rig.store.getOperationRow('client-1', params.envelope.clientOperationId)?.outcome
  ).toMatchObject({
    status: 'failed',
    code: 'agent_session_operation_unknown',
    details: { reason: 'tabUnconfirmed' }
  })
  expect(
    log.entries.some(
      (entry) =>
        entry.fields?.scope === 'create-tab-publication' &&
        entry.fields?.sessionId === SESSION &&
        entry.fields?.error === failure
    )
  ).toBe(true)
})
