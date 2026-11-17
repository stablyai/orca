import { expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './rpc/server/runtime-rpc'
import { STRUCTURED_AGENT_SESSION_ITEM_METHODS } from './rpc/methods/structured-sessions/history/structured-agent-session-item'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/agent-session/agent-session-runtime-capabilities'
import { resolveRemoteConnection } from '../../cli/runtime/pairing/runtime-remote-pairing'
import { sendRemoteRuntimeRequestOnSocket } from '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import type { AutomationReceiptRead } from '../../shared/automations/automation-receipt-read'
import { makeAutomation } from '../../renderer/src/components/automations/automations-page-fixtures'
import { recordAutomationSavedCard } from './automation-saved-card'

it('reads a real native receipt through the paired encrypted RPC transport on its writer', async () => {
  const sessionId = testOrcaSessionId('paired-native-receipt')
  const rig = await createQueuedMessageTestRig({ sessionId })
  const automation = makeAutomation({
    id: 'collision',
    name: 'Writer-owned',
    createdAt: 100,
    updatedAt: 200
  })
  let present = true
  let ownerAvailable = true
  let currentAutomation = automation
  const runtime = Object.assign(new OrcaRuntimeService(), {
    showAutomation: () => {
      if (!present) {
        throw new Error('Automation not found.')
      }
      return currentAutomation
    },
    automationOwnerPrecondition: () =>
      present && ownerAvailable ? { selector: { kind: 'self' as const } } : null,
    automationEffectiveTimeZone: () => 'UTC'
  })
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: rig.root,
    methods: STRUCTURED_AGENT_SESSION_ITEM_METHODS,
    enableWebSocket: true,
    wsPort: 0
  })
  setStructuredAgentSessionHost(rig.host)
  try {
    recordAutomationSavedCard(sessionId, 'created', automation, undefined, () => 'UTC')
    const itemId = 'orca:automation-saved%3Acollision%3A200'
    await eventually(async () =>
      expect(await rig.host.nativeAutomationReceipt(sessionId, itemId)).toMatchObject({
        automation: { name: 'Writer-owned' }
      })
    )
    await server.start()
    const offer = server.createPairingOffer({ name: 'receipt-viewer', scope: 'runtime' })
    if (!offer.available) {
      throw new Error('Pairing unavailable')
    }
    const connection = await resolveRemoteConnection(rig.root, offer.pairingUrl, null)
    if (!connection) {
      throw new Error('Pairing did not resolve')
    }
    const read = () =>
      sendRemoteRuntimeRequestOnSocket<AutomationReceiptRead>(
        connection,
        'agentSession.automationReceipt',
        { sessionId, itemId },
        5000,
        undefined,
        undefined,
        undefined,
        [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      )
    const response = await read()
    expect(response).toMatchObject({
      ok: true,
      result: {
        status: 'ready',
        automation: { id: 'collision', name: 'Writer-owned', createdAt: 100 },
        owner: { selector: { kind: 'self' } },
        effectiveZone: 'UTC'
      }
    })
    currentAutomation = { ...automation, createdAt: 999 }
    expect(await read()).toMatchObject({ ok: true, result: { status: 'mismatch' } })
    currentAutomation = automation
    ownerAvailable = false
    expect(await read()).toMatchObject({ ok: true, result: { status: 'unverified' } })
    present = false
    const missing = await read()
    expect(missing).toMatchObject({ ok: true, result: { status: 'missing' } })
  } finally {
    await server.stop()
    setStructuredAgentSessionHost(null)
    await rig.dispose()
  }
})
