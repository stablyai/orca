import { expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { HOST_TEST_NOW, HOST_TEST_THREAD } from './structured-agent-session-host-test-data'
import {
  CALLER,
  attach,
  attachParams,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'

it("creates a chat while another saved chat's owner check fails", async () => {
  await attach()
  const prior = hostTestState()
  prior.acquire.mockImplementation(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: HOST_TEST_NOW, spawnToken },
    link: {
      linkId: 'new-link',
      handle: codexProviderHandle(HOST_TEST_THREAD),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: HOST_TEST_NOW
    }
  }))
  const peerId = attachParams().envelope.sessionId
  const store = await openTestAgentSessionRecordStore(prior.root)
  const probeOwners = vi.fn(async () => {
    throw new Error('owner check failed')
  })
  const host = new StructuredAgentSessionHost({ ...prior.host.deps, store, probeOwners })
  replaceHostTestState({ store, host })
  const request = attachParams()
  const params = attachParams({
    envelope: { ...request.envelope, sessionId: 'new-chat' },
    accountHome: { variable: 'CODEX_HOME', path: prior.root }
  })

  const result = await host.attach(CALLER, params)

  expect(result.ok, JSON.stringify(result)).toBe(true)
  expect(probeOwners).not.toHaveBeenCalled()
  expect(store.getRecord(peerId)?.lease.unreconciled).toBe(true)
  expect(store.getRecord('new-chat')?.lease.claimStatus).toBe('live')
})
