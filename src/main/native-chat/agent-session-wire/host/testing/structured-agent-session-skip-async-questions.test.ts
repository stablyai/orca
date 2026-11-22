import { expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestSend
} from './structured-agent-session-rest-test-rig.test-fixture'

it('saves Skip on a chat the host has closed, through a row the journal holds', async () => {
  const rig = await createRestTestRig()
  try {
    const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
    if (!attached.ok) {
      throw new Error(`attach refused: ${attached.refusal.code}`)
    }
    const send = restTestSend('first', attached.fence)
    expect(await rig.host.send(REST_TEST_CALLER, send)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalled())
    await rig.restart()
    expect(rig.host.hasSession(SESSION)).toBe(false)

    const row = agentJournalSubmissionKey(send.envelope.clientOperationId)
    await rig.host.skipAsyncQuestions(SESSION, row)
    await rig.host.skipAsyncQuestions(SESSION, 'no-such-row')
    expect(rig.store.getRecord(SESSION)?.asyncQuestionsSkippedThrough).toBe(row)
  } finally {
    await rig.dispose()
  }
})
