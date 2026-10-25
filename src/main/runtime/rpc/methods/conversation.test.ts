import '../unused-default-rpc-methods.test-fixture'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/vitest-host-ports-setup'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { CONVERSATION_METHODS } from './conversation'
import {
  hostStub,
  dispatcher as structuredDispatcher
} from './structured-agent-session-rpc.test-fixture'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type * as ScannerService from '../../../ai-vault/session-scanner-service-spawn'
import type { readConversationTranscript } from '../../../ai-vault/conversation-transcript-reader'
import { parseAgentSessionFile } from '../../../ai-vault/session-scanner-agent-parser'
import { getRuntimeDesktopSurface, setRuntimeDesktopSurface } from '../../runtime-desktop-surface'
import {
  ConversationReferenceSchema,
  ConversationReferencePageSchema
} from '../../../../shared/conversation-reference'

vi.mock('../../../ai-vault/session-scanner-service-spawn', async (original) => ({
  ...(await original<typeof ScannerService>()),
  readConversationTranscriptInService: async (
    ...args: Parameters<typeof readConversationTranscript>
  ) =>
    (await import('../../../ai-vault/conversation-transcript-reader')).readConversationTranscript(
      ...args
    )
}))

const roots: string[] = []
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('conversation reference RPC', () => {
  it('forwards missing source references only through the installed desktop connection owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-reference-routing-'))
    roots.push(root)
    installFakeAppEnvironment({ getPath: () => root })
    const original = getRuntimeDesktopSurface()
    const dispatcher = structuredDispatcher({}, CONVERSATION_METHODS)
    const request = {
      id: 'foreign-read',
      authToken: 'test',
      method: 'conversation.read',
      params: {
        reference:
          'orca-conversation://reference/12345678-1234-4234-8234-123456789abc?host=runtime%3Asource'
      }
    }
    const forward = vi.fn(async () => ({ messages: [], nextCursor: null, warnings: [] }))
    try {
      setRuntimeDesktopSurface(null)
      expect(await dispatcher.dispatch(request)).toMatchObject({ ok: false })
      setRuntimeDesktopSurface({ ...original, forwardConversationReference: forward })
      expect(await dispatcher.dispatch(request)).toMatchObject({ ok: true })
      expect(forward).toHaveBeenCalledWith('conversation.read', request.params)
      expect(
        await dispatcher.dispatch({
          ...request,
          params: { ...request.params, localOnly: true }
        })
      ).toMatchObject({ ok: false })
      expect(forward).toHaveBeenCalledTimes(1)
    } finally {
      setRuntimeDesktopSurface(original)
    }
  })

  it('reads a native conversation through its journal without resuming its agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-reference-'))
    roots.push(root)
    installFakeAppEnvironment({ getPath: () => root })
    const host = hostStub()
    const record = agentSessionRecordFixture()
    const items: AgentJournalRenderItem[] = ['native question', 'native answer'].map(
      (text, index) => ({
        itemId: `native-item-${index}`,
        sequence: index + 1,
        revision: 1,
        observedAt: 1000 + index,
        body: {
          kind: 'message',
          role: index === 0 ? 'user' : 'assistant',
          blocks: [{ type: 'text', text }]
        }
      })
    )
    vi.spyOn(host.deps.store, 'getRecord').mockReturnValue(record)
    vi.spyOn(host, 'journalSnapshot').mockResolvedValue({
      sessionId: record.sessionId,
      cursor: { epoch: 'native-epoch', sequence: 2 },
      items,
      submissions: []
    })
    setStructuredAgentSessionHost(host)
    const dispatcher = structuredDispatcher(
      { ensureStructuredAgentSessionHost: async () => {} },
      CONVERSATION_METHODS
    )
    const created = await dispatcher.dispatch({
      id: 'create-native',
      authToken: 'test',
      method: 'conversation.createReference',
      params: {
        source: {
          kind: 'structured',
          sessionId: record.sessionId,
          workspaceId: record.location.workspaceId
        },
        title: 'Native Claude conversation'
      }
    })
    if (!created.ok) {
      throw new Error(created.error.message)
    }
    const reference = ConversationReferenceSchema.parse(created.result)
    const read = await dispatcher.dispatch({
      id: 'read-native',
      authToken: 'test',
      method: 'conversation.read',
      params: { reference: reference.uri }
    })
    if (!read.ok) {
      throw new Error(read.error.message)
    }
    expect(
      ConversationReferencePageSchema.parse(read.result).messages.map((message) => message.text)
    ).toEqual(['native question', 'native answer'])
    expect(host.revealSession).not.toHaveBeenCalled()
  })

  it('registers a source, persists its identity, and serves paginated reads and session-only search', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-conversation-rpc-'))
    roots.push(root)
    installFakeAppEnvironment({ getPath: () => root })
    const filePath = join(root, 'cursor-session.jsonl')
    await writeFile(
      filePath,
      `${[
        { role: 'user', content: 'opening request' },
        { role: 'assistant', content: 'answer with needle' }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`
    )
    const session = await parseAgentSessionFile(
      {
        agent: 'cursor',
        codexHome: null,
        file: { path: filePath, mtimeMs: 1, modifiedAt: new Date(1).toISOString() }
      },
      process.platform
    )
    expect(session).not.toBeNull()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These explicit methods only use the runtime envelope, source listing, and host installation members.
    const runtime = {
      getRuntimeId: () => 'fixture-runtime',
      listAiVaultSessions: async () => ({
        sessions: [session],
        issues: [],
        scannedAt: new Date().toISOString()
      }),
      ensureStructuredAgentSessionHost: async () => {}
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CONVERSATION_METHODS })
    const registered = await dispatcher.dispatch({
      id: 'register',
      authToken: 'test',
      method: 'conversation.createReference',
      params: {
        source: { kind: 'transcript', agent: 'cursor', sessionId: 'cursor-session', filePath },
        title: 'Cursor work'
      }
    })
    expect(registered.ok).toBe(true)
    if (!registered.ok) {
      throw new Error(registered.error.message)
    }
    const reference = ConversationReferenceSchema.parse(registered.result)
    expect(reference.uri).not.toContain(root)
    const read = async (params: object) => {
      const result = await dispatcher.dispatch({
        id: 'read',
        authToken: 'test',
        method: 'conversation.read',
        params: { reference: reference.uri, ...params }
      })
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      return ConversationReferencePageSchema.parse(result.result)
    }
    const first = await read({ limit: 1 })
    expect(first.messages.map((message) => message.text)).toEqual(['opening request'])
    const second = await read({ cursor: first.nextCursor, limit: 1 })
    expect(second.messages.map((message) => message.text)).toEqual(['answer with needle'])
    expect(second.nextCursor).toBeNull()
    expect((await read({ query: 'needle' })).messages.map((message) => message.text)).toEqual([
      'answer with needle'
    ])
  })
})
