import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import * as fleet from './orchestration-fleet-agent-status-snapshot'
import { conversationRecordReader } from './orchestration/structured-session-lineage'
import { scaleDirectory, scaleJournal, scaleRecord } from './agent-session-scale.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session/records/agent-session-record-store-test-harness'
import { JournalReadConnection } from '../native-chat/agent-session-journal/journal-sql-owner'
import { AGENT_SESSION_PREDECESSOR_IDS } from './agent-session-record-lineage'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'

export const snapshot = (worktree: string, snapshotVersion = 1) => ({
  worktree,
  publicationEpoch: 'sender-snapshot-test',
  snapshotVersion,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: []
})
export const graph = (version = 1) => ({
  tabs: [],
  leaves: [],
  mobileSessionTabs: [snapshot('workspace-1', version), snapshot('workspace-2', version)]
})
export const identities = (frame: RuntimeMobileSessionTabsResult) =>
  frame.agentSenderAssociations?.associations.map((row) => row.identity).sort()

async function senderRecords() {
  const root = await scaleDirectory()
  await seedTestAgentSessionRecordStore(root, {
    records: ['session-a', 'session-c', 'session-d'].map((id) => scaleRecord(id)),
    sessionTabs: [{ sessionId: 'session-c', tabId: 'tab-c' }]
  })
  const store = await openTestAgentSessionRecordStore(root)
  expect(store.listHeldSessionIds().sort()).toEqual(['session-a', 'session-c', 'session-d'])
  const peer = await scaleJournal(root, 'peer-session')
  const read = vi
    .spyOn(fleet, 'readAgentOrchestrationProjectionRecords')
    .mockReturnValue(conversationRecordReader(store))
  return { root, store, peer, read }
}

export async function setup() {
  const { root, store, peer, read } = await senderRecords()
  const runtime = new OrcaRuntimeService(null)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, graph(), { includeAgentSenders: false })
  const senders = runtime['agentProjections'].senders
  return { root, store, peer, read, runtime, senders }
}

/** Hold the actual indexed native page after snapshot priming, outside mutation admission. */
export function holdRead(fail = false) {
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const pages = JournalReadConnection.prototype.pages
  let first = true
  vi.spyOn(JournalReadConnection.prototype, 'pages').mockImplementation(async function* (
    this: JournalReadConnection,
    sql,
    parameters,
    one
  ) {
    for await (const page of pages.call(this, sql, parameters, one)) {
      if (first && sql === AGENT_SESSION_PREDECESSOR_IDS) {
        first = false
        held.resolve()
        await release.promise
        if (fail) {
          throw new Error('held native read failed')
        }
      }
      yield page
    }
  })
  return { held: held.promise, release: release.resolve }
}

export async function withHeldSenderDiscovery(
  runtime: OrcaRuntimeService,
  run: (release: () => Promise<void>) => Promise<void>
): Promise<void> {
  await senderRecords()
  const gate = holdRead()
  const pending = runtime['agentProjections'].senders.build()
  try {
    await gate.held
    await run(async () => {
      gate.release()
      await pending
    })
  } finally {
    gate.release()
    await pending
  }
}
