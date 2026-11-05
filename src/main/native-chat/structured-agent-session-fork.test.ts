import { copyAcpConversation } from '../acp/acp-conversation-copy'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import type { AcpStructuredConnection } from '../acp/acp-structured-connection'
import { PI_CWD_BUCKET_LAYOUT } from '../ai-vault/session-cwd-bucket-layouts'
import { handleStructuredAgentSessionCreate } from '../runtime/rpc/methods/structured-agent-session-create-handler'
import type { StructuredAgentSessionAdapter } from './agent-session-wire/structured-agent-session-adapter'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentSessionRecordFixture } from './agent-session-record-test-fixture'
import { codexProviderHandle } from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSnapshot } from '../../shared/agent-session/journal/agent-session-journal-types'
import { prepareStructuredAgentSessionFork } from './structured-agent-session-fork'
import type { StructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-host'
import {
  createRestTestRig,
  type RestTestRig
} from './agent-session-wire/structured-agent-session-rest-test-rig'
import { structuredAgentSessionCreateParams } from '../../shared/agent-session/structured-agent-session-create'
import { prepareStructuredAgentSessionCreateForWorktree } from '../runtime/rpc/methods/structured-agent-session-create'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { setStructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-registry'

const SOURCE = '019e6b26-18e2-7103-b7a0-7ba6bb071123'
const COPY = '019e6b26-18e2-7103-b7a0-7ba6bb071124'
let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

function source() {
  let admissions = 0
  let capability: 'checkpoint' | 'tip' = 'checkpoint'
  const record = agentSessionRecordFixture({
    sessionId: 'source-chat',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: join(rig.root, 'source-account') },
    options: { model: 'retired-model', effort: 'high', fastMode: 'false' },
    permissionMode: 'accept-edits',
    launchArgs: ['--no-daemon'],
    launchDirectory: rig.root,
    providerHandleChain: [
      {
        linkId: 'source-head',
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1,
        handle: codexProviderHandle(SOURCE)
      }
    ]
  })
  const snapshot: AgentJournalSnapshot = {
    sessionId: record.sessionId,
    cursor: { epoch: 'source-epoch', sequence: 5 },
    submissions: [],
    items: [
      {
        itemId: agentJournalItemKey({
          provider: 'codex',
          threadId: SOURCE,
          turnId: 'completed-turn',
          ordinal: 0
        }),
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Remember the nonce 57319' }]
        }
      },
      {
        itemId: 'ended-root',
        sequence: 2,
        revision: 1,
        observedAt: 2,
        body: { kind: 'turn', turnId: 'completed-turn', state: 'completed' }
      },
      {
        itemId: 'selected-response',
        sequence: 3,
        revision: 1,
        observedAt: 3,
        turnScope: { kind: 'turn', turnItemId: 'ended-root' },
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Remembered' }] }
      },
      {
        itemId: 'running-root',
        sequence: 3,
        revision: 1,
        observedAt: 3,
        body: { kind: 'turn', turnId: 'active-turn', state: 'running' }
      },
      {
        itemId: 'ended-child',
        sequence: 4,
        revision: 1,
        observedAt: 4,
        agentId: 'child',
        body: { kind: 'turn', turnId: 'child-turn', state: 'completed' }
      }
    ]
  }
  const copy = vi.fn(
    async (
      _input: Parameters<NonNullable<StructuredAgentSessionAdapter['copyConversation']>>[0]
    ): ReturnType<NonNullable<StructuredAgentSessionAdapter['copyConversation']>> => {
      const dir = join(rig.root, 'source-account', 'sessions', '2026', '11', '03')
      await mkdir(dir, { recursive: true })
      const filePath = join(dir, `rollout-2026-11-03T19-00-00-${COPY}.jsonl`)
      await writeFile(
        filePath,
        `${[
          {
            type: 'session_meta',
            payload: { id: COPY, timestamp: '2026-11-03T19:00:00.000Z', cwd: rig.root }
          },
          {
            type: 'response_item',
            timestamp: '2026-11-03T19:00:01.000Z',
            payload: { type: 'message', role: 'user', content: 'Remember the nonce 57319' }
          }
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      )
      return { sessionId: COPY, filePath }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preparation reads only these source/store/adapter facets; destination founding uses the real rig host below.
  const host = {
    deps: {
      store: {
        selectWritableRecord: () => ({ kind: 'writable' }),
        requireWritableRecord: () => record,
        listConversations: () => [],
        admittedSendCount: () => admissions
      },
      agents: { capabilities: () => ({ fork: capability }) },
      adapter: { copyConversation: copy },
      logger: { warn: vi.fn() },
      resolveWorkspacePath: async () => rig.root
    },
    journalSnapshot: async () => snapshot
  } as unknown as StructuredAgentSessionHost
  const intent = structuredAgentSessionCreateParams({
    sessionId: 'codex_independent_child',
    agent: 'codex',
    worktree: 'id:workspace-1',
    forkFrom: { sessionId: record.sessionId, throughItemId: 'selected-response' },
    now: rig.clock.now,
    randomUuid: () => '00000000-0000-0000-0000-000000000123'
  })
  const prepare = () =>
    prepareStructuredAgentSessionFork({
      host,
      sessionId: record.sessionId,
      throughItemId: 'selected-response',
      agent: 'codex',
      location: record.location,
      envelope: intent.envelope
    })
  return {
    record,
    snapshot,
    copy,
    host,
    intent,
    prepare,
    admit: () => {
      admissions++
    },
    tip: () => {
      capability = 'tip'
      snapshot.items = snapshot.items.filter((item) => item.itemId !== 'running-root')
    }
  }
}

it('copies the selected retained root, founds its relationship and title, and replays before source discovery', async () => {
  const test = source()
  const unchanged = structuredClone(test.record)
  const params = await test.prepare()
  expect(test.copy.mock.calls[0]?.[0]).toMatchObject({
    providerSessionId: SOURCE,
    checkpoint: { turnId: 'completed-turn' }
  })
  expect(test.record).toEqual(unchanged)
  const result = await rig.host.create({ callerKey: 'device-1' }, params)
  if (!result.ok) {
    throw new Error(JSON.stringify(result))
  }
  expect(result).toMatchObject({
    ok: true,
    value: {
      page: {
        items: [
          expect.objectContaining({
            body: expect.objectContaining({
              role: 'user',
              blocks: [{ type: 'text', text: 'Remember the nonce 57319' }]
            })
          }),
          expect.objectContaining({
            body: expect.objectContaining({
              presentation: 'forked-from',
              forkedFrom: { sessionId: 'source-chat' }
            })
          })
        ]
      }
    }
  })
  expect(rig.store.getRecord(test.intent.envelope.sessionId)).toMatchObject({
    accountHome: test.record.accountHome,
    permissionMode: 'accept-edits',
    conversationName: 'Codex Chat fork',
    forkedFrom: {
      sessionId: 'source-chat',
      itemId: 'selected-response',
      childBoundary: { kind: 'item' }
    },
    options: { model: 'retired-model', effort: 'high', fastMode: 'false' },
    launchArgs: ['--no-daemon'],
    providerHandleChain: [
      expect.objectContaining({ origin: 'adopted', handle: codexProviderHandle(COPY) })
    ]
  })

  setStructuredAgentSessionHost(rig.host)
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'resolveStructuredAgentSessionLocation').mockResolvedValue(test.record.location)
  const replay = await prepareStructuredAgentSessionCreateForWorktree({
    ...test.intent,
    runtime,
    ensureHost: async () => rig.host,
    caller: { callerKey: 'device-1' },
    atRest: true
  })
  expect(await rig.host.create({ callerKey: 'device-1' }, replay.attachParams)).toMatchObject({
    ok: true,
    replayed: true
  })
  expect(test.copy).toHaveBeenCalledOnce()
})

it('requires a post-clear completed context and leaves the source untouched on a copy failure', async () => {
  const test = source()
  test.snapshot.items.unshift({
    itemId: 'clear',
    sequence: 5,
    revision: 1,
    observedAt: 5,
    body: {
      kind: 'status',
      text: 'Context cleared',
      contextClear: { operationId: 'clear-1', afterFence: 1, clearedAt: 5 }
    }
  })
  await expect(test.prepare()).rejects.toMatchObject({
    refusal: { details: { reason: 'savedConversationMissing' } }
  })
  expect(test.copy).not.toHaveBeenCalled()
  test.snapshot.items.shift()
  const unchanged = structuredClone(test.record)
  test.copy.mockRejectedValueOnce(new Error('private provider details'))
  await expect(test.prepare()).rejects.toMatchObject({
    refusal: { details: { reason: 'providerRejected' } }
  })
  expect(test.record).toEqual(unchanged)
})

it('rejects a tip-only copy if a same-head send is admitted during capture', async () => {
  const test = source()
  test.tip()
  test.copy.mockImplementationOnce(async () => {
    test.admit()
    return { sessionId: COPY, filePath: '' }
  })
  await expect(test.prepare()).rejects.toMatchObject({
    refusal: { message: expect.stringContaining('source context changed') }
  })
})

it('refuses a rewind completed during copying when its context retired the selected response', async () => {
  const test = source()
  test.copy.mockImplementationOnce(async () => {
    test.snapshot.items = []
    return { sessionId: COPY, filePath: '' }
  })
  await expect(test.prepare()).rejects.toMatchObject({
    refusal: { message: expect.stringContaining('source context changed') }
  })
})

it('keeps an earlier immutable response available while an unrelated later turn streams', async () => {
  const test = source()
  const nativeCopy = test.copy.getMockImplementation()!
  test.copy.mockImplementationOnce(async (input) => {
    test.admit()
    test.snapshot.items.push({
      itemId: 'later-stream',
      sequence: 5,
      revision: 1,
      observedAt: 5,
      turnScope: { kind: 'turn', turnItemId: 'running-root' },
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'A newer response is streaming' }]
      }
    })
    return nativeCopy(input)
  })
  await expect(test.prepare()).resolves.toMatchObject({ fork: { itemId: 'selected-response' } })
})

it.each(['checkpoint', 'tip'] as const)(
  'revalidates %s copies against the appropriate source identity on relaunch',
  async (capability) => {
    const test = source()
    if (capability === 'tip') {
      test.tip()
    }
    const nativeCopy = test.copy.getMockImplementation()!
    test.copy.mockImplementationOnce(async (input) => {
      test.record.providerHandleChain = [
        ...test.record.providerHandleChain,
        {
          ...test.record.providerHandleChain[0]!,
          linkId: 'relaunched',
          origin: 'resumed',
          mintedAtFence: 2,
          observedAt: 9
        }
      ]
      return nativeCopy(input)
    })
    await (capability === 'checkpoint'
      ? expect(test.prepare()).resolves.toMatchObject({ fork: { itemId: 'selected-response' } })
      : expect(test.prepare()).rejects.toMatchObject({
          refusal: { details: { reason: 'savedConversationMissing' } }
        }))
  }
)

it('owns a slow fork through production create so an identical replay makes exactly one native copy', async () => {
  const test = source()
  const getRecord = rig.store.getRecord.bind(rig.store)
  const writable = rig.store.requireWritableRecord.bind(rig.store)
  const select = rig.store.selectWritableRecord.bind(rig.store)
  const snapshot = rig.host.journalSnapshot.bind(rig.host)
  vi.spyOn(rig.store, 'getRecord').mockImplementation((id) =>
    id === 'source-chat' ? test.record : getRecord(id)
  )
  vi.spyOn(rig.store, 'requireWritableRecord').mockImplementation((id) =>
    id === 'source-chat' ? test.record : writable(id)
  )
  vi.spyOn(rig.store, 'selectWritableRecord').mockImplementation((id) =>
    id === 'source-chat' ? { kind: 'writable', record: test.record } : select(id)
  )
  vi.spyOn(rig.host, 'journalSnapshot').mockImplementation((id) =>
    id === 'source-chat' ? Promise.resolve(test.snapshot) : snapshot(id)
  )
  const capabilities = rig.host.deps.agents.capabilities.bind(rig.host.deps.agents)
  vi.spyOn(rig.host.deps.agents, 'capabilities').mockImplementation((agent) => {
    const supported = capabilities(agent)
    return supported ? { ...supported, fork: 'checkpoint' } : null
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const nativeCopy = test.copy.getMockImplementation()!
  test.copy.mockImplementation(async (input) => {
    entered.resolve()
    await release.promise
    return nativeCopy(input)
  })
  rig.host.deps.adapter.copyConversation = test.copy
  setStructuredAgentSessionHost(rig.host)
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'resolveStructuredAgentSessionLocation').mockResolvedValue(test.record.location)
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockResolvedValue(undefined)
  const ctx = { runtime, clientId: 'device-1' }
  const first = handleStructuredAgentSessionCreate(test.intent, ctx)
  await entered.promise
  const replay = handleStructuredAgentSessionCreate(test.intent, ctx)
  release.resolve()
  const results = await Promise.all([first, replay])
  expect(results).toMatchObject([
    { ok: true, value: { sessionId: 'codex_independent_child' } },
    { ok: true, replayed: true, value: { sessionId: 'codex_independent_child' } }
  ])
  expect(test.copy).toHaveBeenCalledOnce()
  const conflicting = structuredAgentSessionCreateParams({
    ...test.intent,
    sessionId: test.intent.envelope.sessionId,
    forkFrom: { sessionId: 'another-source', throughItemId: 'other-response' },
    now: rig.clock.now,
    randomUuid: () => '00000000-0000-0000-0000-000000000123'
  })
  expect(await handleStructuredAgentSessionCreate(conflicting, ctx)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_conflict' }
  })
  expect(test.copy).toHaveBeenCalledOnce()
})

it.each([true, false])(
  'admits an imported ACP tip only with native terminal evidence, completed: %s',
  async (completed) => {
    const test = source()
    test.tip()
    const home = join(rig.root, 'omp-account')
    const sessions = join(home, 'sessions')
    const directory = join(sessions, `${PI_CWD_BUCKET_LAYOUT.encodeScopePrefixes(rig.root)[0]}--`)
    await mkdir(directory, { recursive: true })
    const transcript = (id: string) =>
      `${[
        { type: 'session', version: 3, id, cwd: rig.root },
        {
          type: 'message',
          id: 'prompt',
          parentId: null,
          message: { role: 'user', content: 'Remember 57319' }
        },
        {
          type: 'message',
          id: 'response',
          parentId: 'prompt',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Remembered' }],
            ...(completed ? { stopReason: 'stop' } : {})
          }
        }
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')}\n`
    await writeFile(join(directory, `${SOURCE}.jsonl`), transcript(SOURCE))
    test.record.provider = 'omp'
    test.record.accountHome = { variable: 'PI_CODING_AGENT_DIR', path: home }
    test.record.providerHandleChain = [
      {
        ...test.record.providerHandleChain[0]!,
        handle: { transport: 'acp', agent: 'omp', nativeId: SOURCE }
      }
    ]
    const selected = agentJournalItemKey({
      provider: 'legacy',
      agent: 'omp',
      sessionId: SOURCE,
      recordId: 'response'
    })
    test.snapshot.items = [
      {
        itemId: agentJournalItemKey({
          provider: 'legacy',
          agent: 'omp',
          sessionId: SOURCE,
          recordId: 'prompt'
        }),
        sequence: 1,
        revision: 0,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Remember 57319' }] }
      },
      {
        itemId: selected,
        sequence: 2,
        revision: 0,
        observedAt: 2,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Remembered' }] }
      }
    ]
    const env = { PI_CODING_AGENT_DIR: home, OMP_CODING_AGENT_DIR: sessions }
    test.host.deps.resolveLaunchEnv = async () => env
    const spec = acpLaunchSpecFor('omp')!
    const initialize = vi.fn(async () => ({
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { fork: {} } }
    }))
    const forkSession = vi.fn(async () => {
      await writeFile(join(directory, `${COPY}.jsonl`), transcript(COPY))
      return COPY
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native copy uses only initialize/forkSession/close on its short-lived connection.
    const connection = {
      initialize,
      forkSession,
      close: async () => true
    } as unknown as AcpStructuredConnection
    test.copy.mockImplementation((input) =>
      copyAcpConversation(
        {
          spec,
          dataDirectory: rig.root,
          readLaunch: async () => ({
            spec,
            command: 'omp',
            prefixArgs: [],
            args: ['acp'],
            cwd: rig.root,
            env,
            envToDelete: [],
            fullAccess: false,
            resume: null
          }),
          connect: () => connection
        },
        input,
        { track: () => {} }
      )
    )
    const pending = prepareStructuredAgentSessionFork({
      host: test.host,
      agent: 'omp',
      sessionId: 'source-chat',
      throughItemId: selected,
      location: test.record.location,
      envelope: test.intent.envelope
    })
    if (completed) {
      await expect(pending).resolves.toMatchObject({
        agent: 'omp',
        fork: { itemId: selected },
        adopt: { providerHandle: { nativeId: COPY } }
      })
      expect(initialize).toHaveBeenCalledOnce()
      expect(forkSession).toHaveBeenCalledWith(SOURCE, rig.root)
    } else {
      await expect(pending).rejects.toMatchObject({
        refusal: { details: { reason: 'turnActive' } }
      })
      expect(test.copy).not.toHaveBeenCalled()
      expect(forkSession).not.toHaveBeenCalled()
    }
  }
)
