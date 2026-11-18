import { OrcaRuntimeService } from '../../../../runtime/orca-runtime'
import { forkTestSource } from './structured-agent-session-fork.test-fixture'
import { handleStructuredAgentSessionCreate } from '../../../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create-handler'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  type RestTestRig
} from '../../host/testing/structured-agent-session-rest-test-rig.test-fixture'
import { setStructuredAgentSessionHost } from '../../host/structured-agent-session-registry'

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

it('reopens a closed fork in the epoch its fork copy installed', async () => {
  const test = forkTestSource(rig, 'claude')
  const getRecord = rig.store.getRecord.bind(rig.store)
  const writable = rig.store.requireWritableRecord.bind(rig.store)
  const select = rig.store.selectWritableRecord.bind(rig.store)
  const boundary = rig.host.forkBoundary.bind(rig.host)
  vi.spyOn(rig.store, 'getRecord').mockImplementation((id) =>
    id === 'source-chat' ? test.record : getRecord(id)
  )
  vi.spyOn(rig.store, 'requireWritableRecord').mockImplementation((id) =>
    id === 'source-chat' ? test.record : writable(id)
  )
  vi.spyOn(rig.store, 'selectWritableRecord').mockImplementation((id) =>
    id === 'source-chat' ? { kind: 'writable', record: test.record } : select(id)
  )
  vi.spyOn(rig.host, 'forkBoundary').mockImplementation((id, itemId, anchor, compare) =>
    id === 'source-chat'
      ? test.host.forkBoundary(id, itemId, anchor, compare)
      : boundary(id, itemId, anchor, compare)
  )
  const capabilities = rig.host.deps.agents.capabilities.bind(rig.host.deps.agents)
  vi.spyOn(rig.host.deps.agents, 'capabilities').mockImplementation((agent) => {
    const supported = capabilities(agent)
    return supported ? { ...supported, fork: 'checkpoint' } : null
  })
  rig.host.deps.adapter.copyConversation = test.copy
  setStructuredAgentSessionHost(rig.host)
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'resolveStructuredAgentSessionLocation').mockResolvedValue(test.record.location)
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockResolvedValue(undefined)
  const created = await handleStructuredAgentSessionCreate(test.intent, {
    runtime,
    clientId: 'device-1'
  })
  expect(created).toMatchObject({ ok: true, value: { sessionId: 'claude_independent_child' } })

  const { lifetime } = rig.host.collaboratorsForTests()
  await lifetime.close('claude_independent_child', 'evict')
  await expect(lifetime.conversation('claude_independent_child')).resolves.toMatchObject({
    journal: expect.anything()
  })
})
