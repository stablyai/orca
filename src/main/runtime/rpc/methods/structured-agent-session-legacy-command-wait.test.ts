import { afterEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER
} from '../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId,
  hostTestMessage
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { sendStructuredAgentSessionForClient } from './structured-agent-session-send-compatibility'
import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'
import { agentSessionMessagePayload } from '../../../../shared/structured-agent-session-send-mutation'

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(['accepted', 'pending', 'oldest'] as const)(
  'real %s reader wait tier behind an active command uses its actual budget and eventual wake',
  async (tier) => {
    vi.useFakeTimers()
    vi.setSystemTime(HOST_TEST_NOW)
    vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
    const rig = await createQueuedMessageTestRig({ now: () => Date.now() })
    setStructuredAgentSessionHost(rig.host)
    try {
      const working = await rig.workingSend()
      await rig.settleAccepted(working, 'warmup')
      const commandId = hostTestOperationId()
      const commandFields = { command: 'compact' as const }
      const command = rig.host.conversationCommand(QUEUED_RIG_CALLER, {
        ...commandFields,
        envelope: rig.envelope(commandFields, 'agentSession.conversationCommand', commandId),
        userSend: true
      })
      await eventually(() => expect(rig.compact).toHaveBeenCalledTimes(1))
      await command
      const body = hostTestMessage('M behind compact')
      const messageId = hostTestOperationId()
      let replied = false
      const wait = vi.spyOn(rig.host, 'waitForSendSettlement')
      const reply = sendStructuredAgentSessionForClient(
        {
          body,
          envelope: rig.envelope(
            { body: agentSessionMessagePayload(body) },
            'agentSession.send',
            messageId
          )
        },
        {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installed-host registry path never reads runtime methods.
          runtime: {} as RpcContext['runtime'],
          clientId: QUEUED_RIG_CALLER.callerKey,
          clientKind: 'runtime',
          clientCapabilities: [
            STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
            ...(tier === 'accepted' ? [AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY] : []),
            ...(tier === 'pending' ? [AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY] : [])
          ]
        }
      ).then((result) => {
        replied = true
        return result
      })
      await eventually(async () =>
        expect(await rig.submission(messageId)).toMatchObject({ dispatchState: 'pending' })
      )
      if (tier !== 'accepted') {
        expect(wait).toHaveBeenCalledWith(SESSION, messageId, {
          until: tier === 'oldest' ? 'answered' : 'handed-over-or-behind-command',
          budgetMs: 120_000
        })
      }
      if (tier !== 'oldest') {
        expect(await reply).toMatchObject({
          ok: true,
          value: { submission: { dispatchState: 'pending' } }
        })
      }
      await vi.advanceTimersByTimeAsync(15_001)
      expect(replied).toBe(tier !== 'oldest')
      if (tier === 'oldest') {
        await vi.advanceTimersByTimeAsync(100_000)
        expect(replied).toBe(false)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(await reply).toMatchObject({
          ok: true,
          value: { submission: { dispatchState: 'pending' } }
        })
      }
      expect((await rig.submission(messageId))?.handedOverAt).toBeUndefined()
      rig.finishCompact()
      await eventually(async () =>
        expect((await rig.submission(messageId))?.handedOverAt).toBeDefined()
      )
      await rig.settleAccepted(messageId, `M-${tier}`)
      expect((await rig.submission(messageId))?.dispatchState).toBe('accepted')
      expect(
        rig.dispatch.mock.calls.filter(([input]) => input.clientMessageId === messageId)
      ).toHaveLength(1)
    } finally {
      await rig.dispose()
    }
  }
)
