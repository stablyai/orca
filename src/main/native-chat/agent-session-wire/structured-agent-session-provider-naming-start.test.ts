import { expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams
} from './structured-agent-session-host-test-data'
import {
  CALLER,
  adapter,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'

it('names a new conversation once and never pushes on true resume', async () => {
  const prior = hostTestState()
  const nameProviderConversation = vi.fn()
  let opened = 0
  const host = new StructuredAgentSessionHost({
    ...prior.host.deps,
    nameProviderConversation,
    adapter: {
      ...adapter(),
      open: async ({ fence }) => ({
        reportedOptions: { model: '' },
        newConversation: ++opened === 1,
        link: {
          linkId: `open-${fence}`,
          handle: codexProviderHandle(HOST_TEST_THREAD),
          origin: 'resumed',
          mintedAtFence: fence,
          observedAt: 1
        }
      })
    }
  })
  replaceHostTestState({ store: prior.store, host })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(nameProviderConversation).toHaveBeenCalledTimes(1))
  await host.close(HOST_TEST_SESSION, 'evict')
  const fence = prior.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
  expect(await host.attach(CALLER, hostTestAttachParams(fence))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(opened).toBe(2))
  await host.flushAllStreamedEvents()
  expect(nameProviderConversation).toHaveBeenCalledTimes(1)
})
