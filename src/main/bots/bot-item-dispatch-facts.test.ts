import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { AgentSessionRecordReader } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { dispatchStarterBotId } from './bot-item-dispatch-facts'

// Whether a session is an agent's own chat is orchestration's own answer; here, by name.
vi.mock('./bot-own-chat', () => ({
  isBotOwnChat: (record: { sessionId: string }) => record.sessionId.endsWith('-chat')
}))

const HOMES: Record<string, string> = {
  'a-chat': 'folder:home-a',
  'b-chat': 'folder:home-b',
  'worker-in-b-home': 'folder:home-b'
}

describe('dispatchStarterBotId', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these bot fields are read.
  const bots = [
    { id: 'a', folderWorkspaceId: 'home-a' },
    { id: 'b', folderWorkspaceId: 'home-b' }
  ] as Bot[]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the dispatch's creator is read.
  const db = {
    getDispatchContextById: (id: string) => ({ creator_orca_session_id: id.slice(4) })
  } as unknown as OrchestrationDb
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only getRecord's session and home are read.
  const records = {
    getRecord: (sessionId: string) =>
      HOMES[sessionId] ? { sessionId, location: { workspaceId: HOMES[sessionId] } } : null
  } as unknown as AgentSessionRecordReader
  const starter = (creator: string, from: AgentSessionRecordReader | null = records) =>
    dispatchStarterBotId(db, `ctx_${creator}`, bots, from)

  it('credits the agent whose own chat started the worker', () => {
    expect(starter('a-chat')).toBe('a')
    expect(starter('b-chat')).toBe('b')
  })

  it('credits nobody for a worker running in an agent’s home, or an unknown starter', () => {
    expect(starter('worker-in-b-home')).toBeNull()
    expect(starter('gone-chat')).toBeNull()
    expect(starter('a-chat', null)).toBeNull()
  })
})
