import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type {
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../../shared/ai-vault/search/ai-vault-search-types'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from '../../ai-vault-search/indexing/session-search-indexer-test-fixture'
import {
  AI_VAULT_SERVICE_PROTOCOL_VERSION,
  type AiVaultServiceChildMessage,
  type AiVaultServiceParentMessage,
  type AiVaultServiceRequestBody,
  type AiVaultServiceResultValue,
  type AiVaultSessionSearchInit
} from './session-scanner-service-protocol'

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let harness: SessionSearchIndexerHarness
let currentRoots: SessionSearchIndexerHarness['roots']
let originalSend: typeof process.send
const sent: AiVaultServiceChildMessage[] = []
const replyWaiters = new Map<number, (reply: AiVaultServiceChildMessage) => void>()
let nextId = 1

function emit(message: AiVaultServiceParentMessage): void {
  process.emit('message', message, undefined)
}

async function call(body: AiVaultServiceRequestBody): Promise<AiVaultServiceResultValue> {
  const id = nextId++
  // Reconcile can outlast a poll window, so wait for this id's reply.
  const replied = new Promise<AiVaultServiceChildMessage>((resolve) =>
    replyWaiters.set(id, resolve)
  )
  emit({ ...body, id })
  const reply = await replied
  if (reply.type === 'error') {
    throw new Error(reply.message)
  }
  if (reply.type !== 'result') {
    throw new Error(`expected a result, got ${reply.type}`)
  }
  return reply
}

async function searchStatus(): Promise<AiVaultSearchStatus> {
  const reply = await call({ type: 'request', operation: 'searchStatus' })
  if (reply.operation !== 'searchStatus') {
    throw new Error(`expected searchStatus, got ${reply.operation}`)
  }
  return reply.value
}

async function searchSessions(query: string): Promise<AiVaultSearchResponse> {
  const reply = await call({ type: 'request', operation: 'searchSessions', request: { query } })
  if (reply.operation !== 'searchSessions') {
    throw new Error(`expected searchSessions, got ${reply.operation}`)
  }
  return reply.value
}

function searchInit(enabled: boolean): AiVaultSessionSearchInit {
  return {
    databasePath: harness.databasePath,
    settings: { enabled, historyDays: null },
    roots: harness.roots
  }
}

beforeAll(async () => {
  harness = await openSessionSearchIndexerHarness('ss-child')
  currentRoots = harness.roots
  await writeClaudeTranscript(
    join(harness.claudeProjectDir, `${SESSION_ID}.jsonl`),
    ['a distinctive conversation'],
    SESSION_ID
  )
  originalSend = process.send
  const record: NonNullable<typeof process.send> = (message) => {
    sent.push(message)
    if (message.type === 'result' || message.type === 'error') {
      replyWaiters.get(message.id)?.(message)
      replyWaiters.delete(message.id)
    }
    if (message.type === 'sessionSearchRoots') {
      queueMicrotask(() =>
        emit({ type: 'sessionSearchRoots', id: message.id, roots: currentRoots })
      )
    }
    return true
  }
  process.send = record
  await import('./session-scanner-service-entry')
  emit({
    type: 'init',
    protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION,
    sessionParseCache: null,
    sessionSearch: searchInit(true)
  })
  await vi.waitFor(() => expect(sent.some((message) => message.type === 'ready')).toBe(true))
})

afterAll(async () => {
  emit({ type: 'sessionSearch', init: searchInit(false) })
  await searchStatus()
  process.send = originalSend
  await harness.cleanup()
})

it('discovers a new root through the parent exchange on manual reconciliation', async () => {
  const lateHome = join(harness.root, 'late-home')
  const id = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  await writeClaudeTranscript(
    join(lateHome, '.claude', 'projects', 'late', `${id}.jsonl`),
    ['freshroots'],
    id
  )
  currentRoots = { ...harness.roots, wslHomeDirs: [lateHome] }
  await call({ type: 'request', operation: 'searchReconcile' })
  const response = await searchSessions('freshroots')
  expect(response.kind).toBe('results')
  if (response.kind === 'results') {
    expect(response.hits.map((hit) => hit.sessionId)).toEqual([id])
  }
})
