// A close must not wait behind a start the provider never answers: the start runs under the
// session's queue, and the close's own stop is queued behind it. The close aborts the start's
// signal instead, at whatever phase the attach is in.

import { expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attachParams,
  CALLER,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

function openHost(state: ReturnType<typeof hostTestState>): StructuredAgentSessionHost {
  const host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store: state.store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(state.root),
    recoveryCapsule: new AgentSessionRecoveryCapsule(state.root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => HOST_TEST_NOW
  })
  replaceHostTestState({ store: state.store, host })
  return host
}

it('a close stops a start the provider never answers instead of queueing behind it', async () => {
  const state = hostTestState()
  let signal: AbortSignal | undefined
  // A start the provider never answers ends only when its acquire is aborted.
  state.acquire.mockImplementation(
    (input) =>
      new Promise((_resolve, reject) => {
        signal = input.signal
        input.signal?.addEventListener('abort', () => reject(new Error('closed while starting')))
      })
  )
  const host = openHost(state)
  const attaching = host.attach(CALLER, attachParams())
  await vi.waitFor(() => expect(state.acquire).toHaveBeenCalled())
  await host.close(SESSION, 'user-close')
  expect(signal?.aborted).toBe(true)
  expect((await attaching).ok).toBe(false)
})

it('a close while the attach still probes the previous owner asks no adapter to start', async () => {
  const state = hostTestState()
  // An adapter that never reads the signal: only the host's own check keeps it from starting.
  const host = openHost(state)
  const runtimeState = host.collaboratorsForTests().runtimeState
  const probe = runtimeState.probeOwner.bind(runtimeState)
  let closing: Promise<void> | undefined
  runtimeState.probeOwner = async (sessionId) => {
    closing ??= host.close(SESSION, 'user-close')
    return probe(sessionId)
  }
  expect(await host.attach(CALLER, attachParams()).catch((error: unknown) => error)).toMatchObject({
    name: 'AgentSessionPreSpawnError'
  })
  await closing
  expect(state.acquire).not.toHaveBeenCalled()
})
