import '../../../../../native-chat/agent-session-wire/delivery/structured-agent-session-send-settlement'
import 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../../../../../../shared/electron-remote-runtime-client-capabilities'
import {
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'

import '../../../../../../shared/agent-session/requests/agent-session-current-requests-capability'
import '../../../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import '../../../../../acp/acp-structured-options'
import '../../../../../acp/generated/acp-protocol.generated'
import '../../../../../ipc/desktop-renderer-runtime-capabilities'

import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub
} from './structured-agent-session-rpc.test-fixture'
import { STRUCTURED_CLIENT } from './structured-agent-session-rpc-client.test-fixture'

import { createQueuedMessageTestRig } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'

import { eventually } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION as HOST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import '../attachments/structured-agent-session-queued-image-capability'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

describe('agentSession.send reply timing', () => {
  it('answers an actual ended legacy send as unknown while keeping raw delivery pending for later proof', async () => {
    const rig = await createQueuedMessageTestRig()
    hostCalls.send.mockImplementation(rig.host.send.bind(rig.host))
    hostCalls.waitForSendSettlement.mockImplementation(
      rig.host.waitForSendSettlement.bind(rig.host)
    )
    const held = new Set<string>()
    rig.host.deps.adapter.heldSends = () => held
    rig.dispatch.mockImplementation(async ({ clientMessageId }) => {
      held.add(clientMessageId)
      return { state: 'admitted' }
    })
    const body = hostTestMessage('legacy answered consumer')
    const id = hostTestOperationId()
    const action = call(
      'agentSession.send',
      { envelope: rig.envelope({ body }, 'agentSession.send', id), body },
      {
        ...STRUCTURED_CLIENT,
        clientCapabilities: Array.from<string>(STRUCTURED_CLIENT.clientCapabilities).filter(
          (capability) =>
            capability !== AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY &&
            capability !== AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY
        )
      }
    )
    try {
      await eventually(() => expect(rig.dispatch).toHaveBeenCalledOnce())
      held.delete(id)
      rig.providerEvents().appendItem(
        { provider: 'legacy', agent: 'codex', sessionId: 'thread-1', recordId: 'final' },
        {
          kind: 'status',
          tone: 'error',
          text: 'final error',
          providerFrame: {
            provider: 'codex',
            kind: 'notification:error',
            payload: { head: '{}', byteLength: 2, digest: '', truncated: false }
          }
        },
        { turnScope: { kind: 'thread' } }
      )
      await rig.host.flushStreamedEvents(HOST_SESSION)
      expect(await action).toMatchObject({
        ok: true,
        result: { value: { submission: { dispatchState: 'unknown' } } }
      })
      expect((await rig.submission(id))?.dispatchState).toBe('pending')
      await rig.settleAccepted(id, 'late')
      expect((await rig.submission(id))?.dispatchState).toBe('accepted')
    } finally {
      await rig.host.close(HOST_SESSION, 'user-close')
      await action
      await rig.dispose()
    }
  })
})
