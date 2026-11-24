import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  closeTestAgentSessionDatabase,
  openTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { seedTestAgentSessionRecordStore } from './agent-session-record-store-persistence.test-fixture'

const roots: string[] = []
export const journals = createTrackedJournalOpener()

export function scaleRecord(sessionId: string, workspaceId = 'workspace-1', links = 1) {
  const row = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId, provenHandleLinkId: `link-${links - 1}` })
  )
  return {
    ...row,
    location: { ...row.location, workspaceId },
    options: { model: 'saved-model' },
    providerHandleChain: Array.from({ length: links }, (_, i) => ({
      ...row.providerHandleChain[0]!,
      linkId: `link-${i}`,
      origin: i === 0 ? ('created' as const) : ('resumed' as const),
      handle: claudeProviderHandle(`provider-${sessionId}-0`, i ? `leaf-${i}` : null)
    }))
  }
}

export async function scaleDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-scale-'))
  roots.push(root)
  return root
}

/** `size` saved chats in a real record store. `work()` counts walks through its whole-store listing
 *  methods, including the store's own calls; an index walk builds views, so count those separately. */
export async function savedChatFleet(size: number) {
  const root = await scaleDirectory()
  const chatIds = Array.from(
    { length: size },
    (_, index) => `chat-${String(index).padStart(5, '0')}`
  )
  await seedTestAgentSessionRecordStore(root, { records: chatIds.map((id) => scaleRecord(id)) })
  const store = await openTestAgentSessionRecordStore(root)
  const listings = [vi.spyOn(store, 'listConversations'), vi.spyOn(store, 'listRecords')]
  const work = () => ({
    wholeListings: listings.reduce((calls, spy) => calls + spy.mock.calls.length, 0)
  })
  return { store, chatIds, work }
}

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  for (const root of roots.splice(0)) {
    // Windows keeps an open SQLite file undeletable.
    await closeTestAgentSessionDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})
