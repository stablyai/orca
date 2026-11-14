import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrackedJournalOpener } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { evictStructuredAgentSession } from '../structured-agent-session-eviction'
import { StructuredAgentSessionHostRuntimeState } from '../../host/structured-agent-session-host-runtime-state'
import { recordingStructuredAgentSessionLogger } from '../../host/testing/structured-agent-session-logger.test-fixture'
import {
  openTestAgentSessionDatabase,
  closeTestAgentSessionRecordStores
} from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'

const journals = createTrackedJournalOpener()
const roots: string[] = []
afterEach(async () => {
  await journals.closeAll()
  await closeTestAgentSessionRecordStores()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function runtimeState(): Promise<StructuredAgentSessionHostRuntimeState> {
  const root = await mkdtemp(join(tmpdir(), 'orca-eviction-activity-'))
  roots.push(root)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the empty conversation map never reaches store or adapter; activity uses the real database.
  const deps = {
    store: {},
    adapter: {},
    journalDatabase: await openTestAgentSessionDatabase(root),
    logger: recordingStructuredAgentSessionLogger().logger
  } as never
  return new StructuredAgentSessionHostRuntimeState(deps, new Map())
}

// Cached sinks must be discarded after close so reopened chats can publish through fresh sinks.
describe('eviction against the real sink cache', () => {
  it('lets the session publish again after it is evicted and reattached', async () => {
    const state = await runtimeState()
    const sessionId = 'session-reattach'
    await evictStructuredAgentSession({
      sessionId,
      logger: recordingStructuredAgentSessionLogger().logger,
      eventSink: state.eventSinkFor(sessionId),
      discardSink: () => state.discardEventSink(sessionId),
      acknowledgeRelease: () => {}
    })

    const root = await mkdtemp(join(tmpdir(), 'orca-eviction-'))
    roots.push(root)
    const journal = await journals.open({
      identity: {
        sessionId,
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread')
      },
      stateDirectory: root
    })
    const published: string[] = []
    const reattached = state.eventSinkFor(sessionId)
    reattached.bind({
      journal,
      fence: 2,
      publish: () => published.push('published')
    })
    reattached.sink.publish()
    await reattached.drained()

    expect(published).toEqual(['published'])
  })
})
