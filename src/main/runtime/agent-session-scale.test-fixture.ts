import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import * as views from '../../shared/agent-session-conversation-view'
import * as handles from '../../shared/agent-session-provider-handle'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  seedTestAgentSessionRecordStore,
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

const roots: string[] = []
export const journals = createTrackedJournalOpener()
export const stringify = JSON.stringify.bind(JSON)

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

export function scaleJournal(root: string, sessionId: string) {
  return journals.open({
    stateDirectory: root,
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle(`provider-${sessionId}-0`, null)
    }
  })
}

export async function scaleDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-scale-'))
  roots.push(root)
  return root
}

export async function scaleStore(n: number) {
  const root = await scaleDirectory()
  const rows = Array.from({ length: n }, (_, i) =>
    scaleRecord(`chat-${String(i).padStart(5, '0')}`, i % 2 ? 'other' : 'workspace-1')
  )
  rows.push(scaleRecord('damaged-chat'), scaleRecord('closed-chat'), scaleRecord('malformed-chat'))
  await seedTestAgentSessionRecordStore(root, {
    records: rows,
    sessionTabs: rows
      .filter((row) => row.sessionId !== 'closed-chat')
      .map((row) => ({ tabId: `tab-${row.sessionId}`, sessionId: row.sessionId }))
  })
  await editPersistedTestAgentSessionStore(root, (state) => {
    Object.assign(state.records['damaged-chat'].lease, { minimumNextFence: 'bad' })
    Object.assign(state.records['malformed-chat'], { providerHandleChain: 'bad' })
  })
  const store = await openTestAgentSessionRecordStore(root)
  return { root, store, rows }
}

/** Transparent counters; every observed call still executes the production operation. */
export function countStoreWork(store?: AgentSessionRecordStore) {
  const counts = {
    views: 0,
    clones: 0,
    cloneBytes: 0,
    decodes: 0,
    links: 0,
    inventories: 0,
    keyed: 0,
    tabReads: 0
  }
  const view = views.agentSessionConversationView
  vi.spyOn(views, 'agentSessionConversationView').mockImplementation((record) => {
    counts.views++
    return view(record)
  })
  const decode = handles.decodePersistedAgentSessionProviderHandleChain
  vi.spyOn(handles, 'decodePersistedAgentSessionProviderHandleChain').mockImplementation(
    (value) => {
      counts.decodes++
      counts.links += Array.isArray(value) ? value.length : 0
      return decode(value)
    }
  )
  const clone = globalThis.structuredClone
  vi.spyOn(globalThis, 'structuredClone').mockImplementation((value) => {
    counts.clones++
    counts.cloneBytes += Buffer.byteLength(stringify(value))
    return clone(value)
  })
  if (store) {
    const inventory = store.listConversations
    vi.spyOn(store, 'listConversations').mockImplementation(() => {
      counts.inventories++
      return inventory()
    })
    const get = store.getConversation
    vi.spyOn(store, 'getConversation').mockImplementation((id) => {
      counts.keyed++
      return get(id)
    })
    const tabs = store.getVisibleSessionTabIndex
    vi.spyOn(store, 'getVisibleSessionTabIndex').mockImplementation(() => {
      counts.tabReads++
      return tabs()
    })
  }
  return {
    counts,
    reset: () => {
      for (const key of Object.keys(counts)) {
        Reflect.set(counts, key, 0)
      }
    }
  }
}

export function countRecordQueries(root: string) {
  let executions = 0
  let rows = 0
  const db = openTestJournalHostDatabase(root).db
  const observed = new WeakSet<object>()
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (
      sql === 'SELECT session_id, record_json FROM agent_session_records ORDER BY rowid' &&
      !observed.has(statement)
    ) {
      observed.add(statement)
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        executions++
        const result = all(...args)
        rows += result.length
        return result
      })
    }
    return statement
  })
  return () => ({ executions, rows })
}

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
