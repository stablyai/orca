import { compileSessionSearchProjectOwnership } from '../ai-vault-search/session-search-project-ownership'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { AiVaultSearchResponse, AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from '../ai-vault-search/session-search-indexer-test-fixture'
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
let nextId = 1

function emit(message: AiVaultServiceParentMessage): void {
  process.emit('message', message, undefined)
}

async function call(body: AiVaultServiceRequestBody): Promise<AiVaultServiceResultValue> {
  const id = nextId++
  emit({ ...body, id })
  const reply = await vi.waitFor(() => {
    const found = sent.find(
      (message) => (message.type === 'result' || message.type === 'error') && message.id === id
    )
    expect(found).toBeDefined()
    return found!
  })
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
  process.send = originalSend
  await harness.cleanup()
})

it('reports the indexer phase and a live generation over the protocol', async () => {
  const status = await vi.waitFor(async () => {
    const value = await searchStatus()
    expect(value.filesIndexed).toBeGreaterThan(0)
    expect(value.phase).toBe('current')
    expect(value.generation).toBeGreaterThan(0)
    return value
  })
  expect(status.enabled).toBe(true)
  expect(existsSync(harness.databasePath)).toBe(true)
})

it('answers a search and a reconcile over the protocol', async () => {
  expect(await call({ type: 'request', operation: 'searchReconcile' })).toEqual({
    operation: 'searchReconcile',
    value: null,
    type: 'result',
    id: expect.any(Number)
  })
  const response = await searchSessions('distinctive')
  expect(response.kind).toBe('results')
  if (response.kind === 'results') {
    expect(response.hits.map((hit) => hit.sessionId)).toEqual([SESSION_ID])
  }
})

it('executes the canonical selection through the actual child message executor and native index', async () => {
  const selection = await compileSessionSearchProjectOwnership(
    {
      repos: [{ id: 'actual', path: '/repo/app', displayName: 'app', badgeColor: '', addedAt: 1 }],
      projects: [],
      projectHostSetups: [],
      worktreeMeta: {},
      settings: { workspaceDir: '', nestWorkspaces: false }
    },
    'repo:actual'
  )
  const response = await call({
    type: 'request',
    operation: 'searchSessions',
    request: { query: 'distinctive' },
    hostScope: { kind: 'canonical', selection }
  })
  expect(response.operation).toBe('searchSessions')
  if (response.operation !== 'searchSessions') {
    throw new Error('wrong operation')
  }
  expect(response.value).toMatchObject({ kind: 'results', hits: [{ sessionId: SESSION_ID }] })
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

it('clears the owned index and rebuilds from the transcripts still on disk', async () => {
  const transcriptPath = join(harness.claudeProjectDir, `${SESSION_ID}.jsonl`)
  expect((await searchSessions('distinctive')).kind).toBe('results')
  rmSync(transcriptPath)

  expect(await call({ type: 'request', operation: 'searchClear' })).toEqual({
    operation: 'searchClear',
    value: null,
    type: 'result',
    id: expect.any(Number)
  })
  expect(await searchSessions('distinctive')).toMatchObject({ kind: 'results', hits: [] })
  expect(existsSync(harness.databasePath)).toBe(true)
})

it('answers disabled once consent is withdrawn, without a respawn', async () => {
  emit({ type: 'sessionSearch', init: searchInit(false) })
  expect(await searchSessions('distinctive')).toEqual({ kind: 'unavailable', reason: 'disabled' })
  expect(await searchStatus()).toMatchObject({ enabled: false, phase: 'idle' })
  emit({ type: 'sessionSearch', init: searchInit(true) })
  expect((await searchSessions('distinctive')).kind).toBe('results')
})
