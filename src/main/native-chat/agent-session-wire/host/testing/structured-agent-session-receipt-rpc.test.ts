import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setStructuredAgentSessionHost } from '../structured-agent-session-registry'
import { STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD as subscribe } from '../../../../runtime/rpc/methods/structured-sessions/subscriptions/structured-agent-session-subscribe-method'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../../../runtime/rpc/methods/structured-sessions/structured-agent-session'
import { MOBILE_AGENT_SESSION_RPC_METHODS } from '../../../../runtime/rpc/server/runtime-rpc-mobile-agent-session-methods'
import { LOCAL_READ_PROVIDER_RECEIPTS } from '../../../../runtime/rpc/methods/structured-sessions/subscriptions/structured-agent-session-read-provider-receipts'
import { classifyRuntimeLongPoll } from '../../../../runtime/rpc/server/runtime-rpc-long-poll'
import { RpcDispatcher } from '../../../../runtime/rpc/dispatcher'
import type { RpcContext } from '../../../../runtime/rpc/core'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { MOBILE_RUNTIME_CAPABILITIES } from '../../../../../shared/remote-runtime/protocol/mobile-runtime-capabilities'
import { ORCAD_RUNTIME_CAPABILITIES } from '../../../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import { HOST_RUNTIME_CAPABILITIES } from '../../../../../shared/remote-runtime/protocol/host-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  claudeReceiptIngress,
  openReceiptStream
} from './structured-agent-session-provider-receipt-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION as CHAT,
  HOST_TEST_NOW as NOW
} from './structured-agent-session-host-test-data.test-fixture'

it.each([
  ['SSH', 'runtime', ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES, ORCAD_RUNTIME_CAPABILITIES],
  ['WSL', 'runtime', ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES, ORCAD_RUNTIME_CAPABILITIES],
  ['direct phone', 'mobile', MOBILE_RUNTIME_CAPABILITIES, HOST_RUNTIME_CAPABILITIES],
  ['relayed phone', 'mobile', MOBILE_RUNTIME_CAPABILITIES, HOST_RUNTIME_CAPABILITIES]
] as const)(
  'preserves the paired %s reply bytes and offers no receipt read',
  async (_route, clientKind, capabilities, hostCapabilities) => {
    const rig = await createQueuedMessageTestRig({ agent: 'claude' })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const signal = new AbortController()
    setStructuredAgentSessionHost(rig.host)
    try {
      const id = await rig.workingSend()
      await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
      const ingress = claudeReceiptIngress(rig)
      const session = await rig.host.conversation(CHAT)
      await session.activityRead
      const cursor = session.journal.cursor()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the actual dispatcher and host use only these runtime methods for the requests below.
      const runtime = {
        getRuntimeId: () => 'paired-runtime',
        registerOwnedSubscriptionCleanup: (_id: string, close: () => void) => ({
          releaseIfCurrent: close
        })
      } as unknown as RpcContext['runtime']
      const opts = {
        clientKind,
        clientCapabilities: [...capabilities, STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
        pairedDeviceId: 'paired-test-device',
        connectionId: 'paired-transport',
        signal: signal.signal
      }
      const dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
      const request = {
        id: 'receipt-read',
        authToken: 'paired',
        method: LOCAL_READ_PROVIDER_RECEIPTS.name
      }
      expect(JSON.stringify(await dispatcher.dispatch(request, opts))).toBe(
        '{"id":"receipt-read","ok":false,"error":{"code":"method_not_found","message":"Unknown method: agentSession.readProviderReceipts"},"_meta":{"runtimeId":"paired-runtime"}}'
      )
      expect(hostCapabilities.some((name) => /provider.receipt/i.test(name))).toBe(false)
      expect(MOBILE_AGENT_SESSION_RPC_METHODS.some((name) => /provider.receipt/i.test(name))).toBe(
        false
      )
      expect(classifyRuntimeLongPoll(request)).toBeNull()
      expect(
        subscribe.params.safeParse({
          sessionId: CHAT,
          receiptReader: { id: randomUUID(), generation: 1 }
        }).success
      ).toBe(false)

      const captured: string[][] = [[], []]
      const open = (index: number) =>
        dispatcher.dispatchStreaming(
          { ...request, id: 'stream', method: subscribe.name, params: { sessionId: CHAT, cursor } },
          (frame) => void captured[index]!.push(frame),
          { ...opts, connectionId: `paired-transport-${index}` }
        )
      await open(0)
      await eventually(() => expect(JSON.stringify(captured[0])).toContain(id))
      const reader = await openReceiptStream(rig)
      ingress.lifecycle('queued', NOW + 100)
      await eventually(() =>
        expect(reader.frames[1]?.updates).toEqual([{ clientMessageId: id, observedAt: NOW + 100 }])
      )
      await open(1)
      await eventually(() => expect(captured[1]).toEqual(captured[0]))
      ingress.echo()
      ingress.assistant()
      await ingress.flush()
      await eventually(() => {
        expect(JSON.stringify(captured[1])).toContain('Hello there')
        expect(captured[1]).toEqual(captured[0])
      })
      reader.close()
    } finally {
      signal.abort()
      clock.mockRestore()
      setStructuredAgentSessionHost(null)
      await rig.dispose()
    }
  }
)
