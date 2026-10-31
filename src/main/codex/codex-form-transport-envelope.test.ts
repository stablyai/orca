import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { replaceHostTestState } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { settledBodySerializationEvidence } from '../native-chat/agent-session-wire/agent-session-settled-body'
import { createBridgePortPair } from '../../../mobile/src/mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { createFakeRpcClient } from '../../../mobile/src/mobile-web-shell/bridge-host-test-fakes'
import { STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS } from '../runtime/rpc/methods/structured-agent-session-prompt-response'
import {
  createSharedControlTestServer,
  closeSharedControlTestServers
} from '../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime/requests/remote-runtime-request-connection'
import { RUNTIME_ORDINARY_MESSAGE_CAPABILITY } from '../../shared/runtime-ordinary-message-capability'
import type { AgentSessionMutationResult } from '../../shared/agent-session-wire'
import { afterEach, expect, it, vi } from 'vitest'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import { CodexPromptRegistry } from './codex-prompt-registry'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { canonicalAgentSessionFormContent } from '../../shared/agent-session-form'
import {
  serializeRemoteRuntimeRpcRequest,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES as M
} from '../../shared/remote-runtime/remote-runtime-memory-limits'
import { buildDirectRpcWireRequest } from '../../../mobile/src/transport/rpc-envelope-fields'
import {
  splitBridgeReply,
  BridgeReplyAssembler
} from '../../../mobile/src/mobile-web-shell/bridge/bridge-reply-chunking'
import { encrypt, decrypt } from '../../shared/e2ee-crypto'
import { sealMobileE2EEV2Frame, openMobileE2EEV2Frame } from '../../shared/mobile-e2ee-v2-framing'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import {
  readSettledBodyPiece,
  settledBodyPresentation
} from '../native-chat/agent-session-wire/agent-session-settled-body'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createAgentSessionSettledBodyReader } from '../../shared/agent-session-settled-body-reader'
import { nativeChatReceiptAnswers } from '../../shared/native-chat-resolution-receipt'
import {
  AgentSessionSettledBodyPieceSchema,
  AGENT_SESSION_SETTLED_BODY_CAPABILITY
} from '../../shared/agent-session-settled-body'
import { readCodexMcpElicitation } from './codex-mcp-elicitation'
import { codexPromptIdentity } from './codex-structured-prompt-items'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import {
  call,
  STRUCTURED_MOBILE_CLIENT
} from '../runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { STRUCTURED_AGENT_SESSION_ITEM_METHODS } from '../runtime/rpc/methods/structured-agent-session-item'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeviceRegistry } from '../runtime/device-registry'
import { rewriteRelayedPhoneRequest } from '../runtime/mobile-desktop-relay/relayed-phone-frames'

let adapter: ReturnType<typeof adapterFor> | undefined
afterEach(async () => {
  await closeSharedControlTestServers()
  setStructuredAgentSessionHost(null)
  await adapter?.closeAll()
  vi.restoreAllMocks()
})

it.each(['WF1', 'WF2', 'literal', 'enum', 63, 64] as const)(
  'preserves complete %s settlement, replay and automatically recovered receipt',
  async (fixture) => {
    const n = typeof fixture === 'number' ? fixture : 20
    const state = hostTestState()
    await attach()
    setStructuredAgentSessionHost(state.host)
    const codex = fakeCodex()
    adapter = adapterFor(codex, { resumeThreadId: THREAD })
    let registry: CodexPromptRegistry | undefined
    const captureRegistry = (value: CodexPromptRegistry) => {
      registry = value
    }
    const bind = CodexPromptRegistry.prototype.bindJournalItemId
    vi.spyOn(CodexPromptRegistry.prototype, 'bindJournalItemId').mockImplementation(function (
      this: CodexPromptRegistry,
      ...args
    ) {
      captureRegistry(this)
      return bind.apply(this, args)
    })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: state.store.getRecord(SESSION)!.lease.runtimeFence,
      spawnToken: 'spawn-a',
      events: state.acquire.mock.calls.at(-1)![0].events
    })
    state.answerPrompt.mockImplementation((input) => adapter!.answerPrompt(input))
    const names = Array.from({ length: n }, (_, i) => (n === 20 ? `f${i}` : `f${i}"\u0000\\\ud800`))
    codex.connections[0].handlers.onServerRequest?.({
      id: 0,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: THREAD,
        turnId: 'turn-1',
        mode: 'form',
        message: 'Enter values',
        requestedSchema: {
          type: 'object',
          properties: Object.fromEntries(
            names.map((name, i) => [
              name,
              fixture === 'enum' && i === 0
                ? {
                    type: 'string',
                    enum: [
                      'a'.repeat(4000) + 'r'.repeat(4000),
                      'a'.repeat(4000) + 'b'.repeat(4000)
                    ],
                    enumNames: ['Red label', 'Blue label']
                  }
                : { type: 'string' }
            ])
          ),
          required: names
        }
      }
    })
    await state.host.flushStreamedEvents(SESSION)
    const journal = state.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const prompt = journal.snapshot().items.find((item) => item.body.kind === 'approval')!
    const live: AgentSessionSubscribeEvent[] = []
    const stopLive =
      fixture === 'WF1'
        ? await state.host.subscribe({
            id: 'pending-to-settled',
            sessionId: SESSION,
            boundedFrames: true,
            readsCurrentRequests: true,
            readsSettledBodies: true,
            emit: (event) => live.push(event)
          })
        : () => {}
    expect(registry).toBeDefined()
    const R = registry!.bytes
    const content = Object.fromEntries(
      names.map((name, i) => [
        name,
        n === 20
          ? i === 0 && fixture === 'enum'
            ? 'a'.repeat(4000) + 'b'.repeat(4000)
            : i === 0 && fixture === 'WF2'
              ? `xx${'kM4'.repeat(12)}${'x'.repeat(59962)}`
              : i === 0 && fixture === 'literal'
                ? 'a000'.repeat(12) + 'x'.repeat(59952)
                : 'x'.repeat(60000)
          : `${'\u0000'.repeat(10922)}xx`
      ])
    )
    // Each value occupies exactly 65536 JSON bytes; the retained definition owns the remaining headroom.
    if (n === 64) {
      const excess = R + Buffer.byteLength(canonicalAgentSessionFormContent(content)) - M
      content[names[0]!] = 'x'.repeat(65534 - excess)
    }
    const canonical = canonicalAgentSessionFormContent(content)
    const C = Buffer.byteLength(canonical)
    expect(R + C).toBeLessThanOrEqual(M)
    if (n === 64) {
      expect(R + C).toBe(M)
    }
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, content }
    const params = { ...fields, envelope: envelope('agentSession.respondTo:approval', fields) }
    const method = 'agentSession.respondToApproval'
    const requestId = 'rpc-9007199254740991-1793399999999'
    const deviceToken = 'a000'.repeat(12)
    const direct = JSON.stringify(
      buildDirectRpcWireRequest(
        {
          id: requestId,
          method,
          params,
          envelope: { executionHost: 'runtime:00000000-0000-0000-0000-000000000000' }
        },
        deviceToken
      )
    )
    if (fixture === 'WF2' || fixture === 'literal') {
      const path = join(state.root, 'synthetic-relay-caller')
      mkdirSync(path)
      writeFileSync(
        join(path, 'orca-devices.json'),
        JSON.stringify([
          {
            deviceId: 'parent',
            token: 'c000'.repeat(12),
            name: 'Fixture desktop',
            scope: 'runtime',
            pairedAt: 1,
            lastSeenAt: 1
          },
          {
            deviceId: 'phone',
            token: deviceToken,
            name: 'Fixture phone',
            scope: 'mobile',
            pairedAt: 1,
            lastSeenAt: 1
          },
          {
            deviceId: 'delegated-phone',
            token: 'b000'.repeat(12),
            name: 'Fixture child',
            scope: 'mobile',
            parentDeviceId: 'parent',
            phoneKey: 'phone',
            pairedAt: 1,
            lastSeenAt: 1
          }
        ])
      )
      const credentials = new DeviceRegistry(path)
      expect(credentials.validateToken(deviceToken)?.deviceId).toBe('phone')
      expect(credentials.validateToken('b000'.repeat(12))?.parentDeviceId).toBe('parent')
    }
    const relayed = JSON.parse(rewriteRelayedPhoneRequest(direct, deviceToken, 'b000'.repeat(12)))
    expect(relayed.params).toEqual(params)
    expect(
      createHash('sha256')
        .update(canonicalAgentSessionFormContent(relayed.params.content))
        .digest('hex')
    ).toBe(createHash('sha256').update(canonical).digest('hex'))
    const remote = serializeRemoteRuntimeRpcRequest({ requestId, deviceToken, method, params })
    const page = JSON.stringify({
      v: 1,
      type: 'request',
      id: '0'.repeat(22),
      method,
      params,
      options: { timeoutMs: 15000, budgetSpansConnect: true },
      envelope: { executionHost: 'runtime:00000000-0000-0000-0000-000000000000' }
    })
    for (const raw of [direct, remote, page]) {
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(M)
    }
    const key = new Uint8Array(32).fill(1)
    const sealed = encrypt(direct, key)
    expect(decrypt(sealed, key)).toBe(direct)
    const frameArgs = {
      key,
      sessionId: new Uint8Array(32).fill(2),
      direction: 'mobile-to-desktop' as const,
      payloadKind: 'text' as const
    }
    const v2 = sealMobileE2EEV2Frame({ ...frameArgs, payload: Buffer.from(direct), counter: 0n })
    expect(
      Buffer.from(
        openMobileE2EEV2Frame({ ...frameArgs, frame: v2, expectedCounter: 0n })!
      ).toString()
    ).toBe(direct)
    expect(Buffer.from(v2).toString('base64').length).toBe(
      4 * Math.ceil((Buffer.byteLength(direct) + 82) / 3)
    )
    // Actual page -> shell request owner -> authenticated ordinary socket -> dispatcher -> journal/adapter.
    const server = await createSharedControlTestServer({
      resultForRequest: async (method, params) => {
        if (method === 'status.get') {
          return { capabilities: [RUNTIME_ORDINARY_MESSAGE_CAPABILITY] }
        }
        const reply = await call(
          method,
          params,
          { ...STRUCTURED_MOBILE_CLIENT, clientId: CALLER.callerKey },
          {},
          STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS
        )
        if (!reply.ok) {
          throw new Error(JSON.stringify(reply.error))
        }
        return reply.result
      }
    })
    const sender = new RemoteRuntimeRequestConnection(server.pairing)
    const rpc = createFakeRpcClient()
    rpc.sendRequest = (method, params) => {
      const wire = JSON.stringify(
        buildDirectRpcWireRequest({ id: requestId, method, params }, deviceToken)
      )
      const forwarded: unknown = JSON.parse(
        rewriteRelayedPhoneRequest(wire, deviceToken, 'b000'.repeat(12))
      )
      if (typeof forwarded !== 'object' || forwarded === null || !('params' in forwarded)) {
        throw new Error('Invalid forwarded request')
      }
      expect(forwarded.params).toEqual(params)
      return sender.request(method, forwarded.params, 15000)
    }
    const bridge = createBridgePortPair({ rpc, inboundMessageBytes: M })
    await bridge.flush()
    expect(bridge.client.getRequestByteCapacity?.()).toBe(M)
    async function submit(params: unknown): Promise<AgentSessionMutationResult<unknown>> {
      const reply = await bridge.client.sendRequest(method, params, { timeoutMs: 15000 })
      // Finish the previous native-post handoff before another explicit press; both processes share a budget in this fixture.
      await bridge.flush()
      if (!reply.ok) {
        throw new Error(JSON.stringify(reply.error))
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real typed host method produced this result; the assertions below verify its complete settlement.
      return reply.result as AgentSessionMutationResult<unknown>
    }
    let first, same, settled
    try {
      first = await submit(params)
      same = await submit(params)
      settled = await submit({
        ...params,
        envelope: envelope('agentSession.respondTo:approval', fields)
      })
      expect(bridge.toPage.every((frame) => Buffer.byteLength(frame) <= 640 * 1024)).toBe(true)
    } finally {
      bridge.client.close()
      bridge.host.dispose()
      sender.close()
    }
    expect(first.ok).toBe(true)
    expect(same.ok && same.replayed).toBe(true)
    expect(settled.ok).toBe(true)
    expect(codex.connections[0].replies).toEqual([
      { id: 0, result: { action: 'accept', content, _meta: null } }
    ])
    const replySizes: number[] = []
    let maxBridgeFrame = 0
    for (const result of [first, same, settled]) {
      const reply = {
        id: requestId,
        ok: true as const,
        result,
        _meta: { runtimeId: '00000000-0000-0000-0000-000000000000' }
      }
      replySizes.push(Buffer.byteLength(JSON.stringify(reply)))
      expect(replySizes.at(-1)).toBeLessThanOrEqual(M)
      const split = splitBridgeReply('0'.repeat(22), reply)
      expect(split.ok).toBe(true)
      if (!split.ok) {
        throw new Error(split.refusal)
      }
      const assembler = new BridgeReplyAssembler()
      let assembled: ReturnType<BridgeReplyAssembler['accept']> | undefined
      for (const frame of split.frames) {
        maxBridgeFrame = Math.max(maxBridgeFrame, Buffer.byteLength(JSON.stringify(frame)))
        assembled = assembler.accept(frame)
      }
      expect(assembled).toEqual({ status: 'complete', payload: reply })
    }
    const saved = journal.snapshot().items.find((item) => item.itemId === prompt.itemId)!
    await state.host.flushStreamedEvents(SESSION)
    if (fixture === 'WF1') {
      const published = live
        .flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
        .find((item) => item.itemId === saved.itemId && item.revision === saved.revision)
      expect(published?.settledBody).toEqual(settledBodyPresentation(saved, true).settledBody)
      expect(published?.body).not.toHaveProperty('resolution.formContent')
      expect(live[0]).toMatchObject({ type: 'snapshot' })
    }
    stopLive()
    await certifyBody(saved, journal, R, C)
    if (fixture === 64) {
      const client = {
        ...STRUCTURED_MOBILE_CLIENT,
        clientCapabilities: [
          ...STRUCTURED_MOBILE_CLIENT.clientCapabilities,
          AGENT_SESSION_SETTLED_BODY_CAPABILITY
        ]
      }
      const detail = await call(
        'agentSession.item',
        { sessionId: SESSION, itemId: saved.itemId },
        client,
        {},
        STRUCTURED_AGENT_SESSION_ITEM_METHODS
      )
      expect(detail).toMatchObject({
        ok: true,
        result: { item: { settledBody: { contract: AGENT_SESSION_SETTLED_BODY_CAPABILITY } } }
      })
      const descriptor = settledBodyPresentation(saved, true).settledBody!
      const bodySource = {
        ...descriptor,
        epoch: journal.cursor().epoch,
        revision: saved.revision,
        cursor: 0
      }
      for (const changed of [
        { ...bodySource, epoch: 'old' },
        { ...bodySource, revision: saved.revision + 1 }
      ]) {
        expect(
          await call(
            'agentSession.item',
            { sessionId: SESSION, itemId: saved.itemId, bodySource: changed },
            client,
            {},
            STRUCTURED_AGENT_SESSION_ITEM_METHODS
          )
        ).toMatchObject({ ok: false })
      }
      expect(
        await call(
          'agentSession.item',
          { sessionId: SESSION, itemId: saved.itemId, bodySource },
          STRUCTURED_MOBILE_CLIENT,
          {},
          STRUCTURED_AGENT_SESSION_ITEM_METHODS
        )
      ).toMatchObject({ ok: false })
      const acquiredBefore = state.acquire.mock.calls.length
      await adapter!.closeAll()
      await state.host.flushAllStreamedEvents()
      const reopened = new StructuredAgentSessionHost({
        ...state.host.deps,
        journalDatabase: openTestJournalHostDatabase(state.root)
      })
      replaceHostTestState({ store: state.store, host: reopened })
      setStructuredAgentSessionHost(reopened)
      const restarted = await reopened.history(
        { sessionId: SESSION, direction: 'tail' },
        undefined,
        true,
        true
      )
      expect(
        restarted.page.items.find((item) => item.itemId === saved.itemId)?.settledBody
      ).toEqual(descriptor)
      const reopenedJournal = reopened.collaboratorsForTests().sessions.get(SESSION)!.journal
      await certifyBody(saved, reopenedJournal, R, C)
      expect(state.acquire).toHaveBeenCalledTimes(acquiredBefore)
      expect(codex.connections[0].replies).toHaveLength(1)
      await reopened.close(SESSION, 'evict')
      expect(settledBodySerializationEvidence()).toEqual({ entries: 0, retainedBytes: 0 })
    }
    const history = await hostTestState().host.history(
      { sessionId: SESSION, direction: 'tail' },
      undefined,
      true,
      true
    )
    const historical = history.page.items.find((item) => item.itemId === prompt.itemId)!
    const full = saved.body.kind === 'approval' ? saved.body.resolution.formContent : undefined
    expect(canonicalAgentSessionFormContent(full!)).toBe(canonical)
    expect(historical.settledBody).toEqual({
      contract: AGENT_SESSION_SETTLED_BODY_CAPABILITY,
      version: 'approval-json.v1',
      state: 'resolved'
    })
    expect(historical.body).not.toHaveProperty('form')
    expect(historical.body).not.toHaveProperty('resolution.formContent')
    for (const [direction, sequence] of [
      ['before', journal.cursor().sequence + 1],
      ['after', prompt.sequence - 1]
    ] as const) {
      const page = await hostTestState().host.history(
        { sessionId: SESSION, direction, cursor: { epoch: journal.cursor().epoch, sequence } },
        undefined,
        false,
        true
      )
      expect(page.page.items.find((item) => item.itemId === saved.itemId)?.settledBody).toEqual(
        historical.settledBody
      )
    }
    const reset = await hostTestState().host.history(
      { sessionId: SESSION, direction: 'after', cursor: { epoch: 'old-epoch', sequence: 0 } },
      undefined,
      false,
      true
    )
    expect(reset.page.items.find((item) => item.itemId === saved.itemId)?.settledBody).toEqual(
      historical.settledBody
    )

    const streams: { bounded: boolean; rowBytes: number; exact: boolean; shortened?: boolean }[] =
      []
    for (const boundedFrames of [false, true]) {
      const events: AgentSessionSubscribeEvent[] = []
      const dispose = await hostTestState().host.subscribe({
        id: `certificate-${boundedFrames}`,
        sessionId: SESSION,
        boundedFrames,
        readsCurrentRequests: true,
        readsSettledBodies: true,
        emit: (event) => events.push(event)
      })
      const snapshot = events.find((event) => event.type === 'snapshot')
      if (snapshot?.type !== 'snapshot') {
        throw new Error('Missing subscription snapshot')
      }
      const item = snapshot.page.items.find((item) => item.itemId === prompt.itemId)!
      expect(item.settledBody).toEqual(historical.settledBody)
      const answer = item.body.kind === 'approval' ? item.body.resolution.formContent : undefined
      const exact = answer !== undefined && canonicalAgentSessionFormContent(answer) === canonical
      streams.push({
        bounded: boundedFrames,
        rowBytes: Buffer.byteLength(JSON.stringify(item)),
        exact,
        shortened: item.shortened
      })
      expect(answer).toBeUndefined()
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(640 * 1024)
      dispose()
    }
    process.stdout.write(
      `${JSON.stringify({
        fixture,
        n,
        R,
        C,
        I: prompt.itemId.length,
        Q: Buffer.byteLength(direct),
        remoteQ: Buffer.byteLength(remote),
        P: Buffer.byteLength(page),
        S: replySizes,
        sealed: sealed.length,
        v2: Buffer.from(v2).toString('base64').length,
        fullRow: Buffer.byteLength(JSON.stringify(saved)),
        historyRow: Buffer.byteLength(JSON.stringify(historical)),
        shortened: historical.shortened,
        streams,
        maxBridgeFrame,
        representationBytes: {
          canonicalJs: canonical.length * 2,
          pageJs: page.length * 2,
          directJs: direct.length * 2,
          contentValueJs: Object.values(content).reduce(
            (total, value) => total + value.length * 2,
            0
          ),
          legacyUtf8: Buffer.byteLength(direct),
          legacyCipher: Buffer.byteLength(direct) + 16,
          legacyBundle: Buffer.byteLength(direct) + 40,
          legacyBase64Js: sealed.length * 2,
          v2HeaderPlaintext: Buffer.byteLength(direct) + 42,
          v2Cipher: Buffer.byteLength(direct) + 58,
          v2Bundle: v2.length,
          v2Base64Js: Buffer.from(v2).toString('base64').length * 2
        },
        providerEffects: codex.connections[0].replies.length
      })}\n`
    )
  }
)

async function certifyBody(
  item: AgentJournalRenderItem,
  journal: AgentSessionJournal,
  R: number,
  C: number
) {
  if (item.body.kind !== 'approval' || !item.body.form) {
    throw new Error('Expected form')
  }
  const json = JSON.stringify(item.body)
  const E = Buffer.byteLength(
    JSON.stringify({ kind: 'form', message: item.body.title, fields: item.body.form.fields })
  )
  const X = Buffer.byteLength(json)
  expect(X).toBeLessThanOrEqual(M + 65536)
  const descriptor = settledBodyPresentation(item, true).settledBody!
  const source = {
    ...descriptor,
    sessionId: SESSION,
    epoch: journal.cursor().epoch,
    itemId: item.itemId,
    revision: item.revision
  }
  const chunks: string[] = []
  let cursor = 0,
    count = 0,
    maxJ = 0,
    maxFrame = 0,
    maxLegacy = 0,
    maxV2 = 0
  const key = new Uint8Array(32).fill(1)
  for (;;) {
    const piece = readSettledBodyPiece(journal, { ...source, cursor })
    expect(piece.json.length).toBeLessThanOrEqual(24576)
    const next = cursor + piece.json.length
    expect(piece.nextCursor).toBe(next === json.length ? null : next)
    const reply = {
      id: 'rpc-9007199254740991-1793399999999',
      ok: true as const,
      result: piece,
      _meta: { runtimeId: '00000000-0000-0000-0000-000000000000' }
    }
    const raw = JSON.stringify(reply)
    maxJ = Math.max(maxJ, Buffer.byteLength(raw))
    maxLegacy = Math.max(maxLegacy, encrypt(raw, key).length)
    const v2 = sealMobileE2EEV2Frame({
      key,
      sessionId: new Uint8Array(32).fill(2),
      direction: 'desktop-to-mobile',
      payloadKind: 'text',
      payload: Buffer.from(raw),
      counter: BigInt(count)
    })
    maxV2 = Math.max(maxV2, Buffer.from(v2).toString('base64').length)
    const split = splitBridgeReply('0'.repeat(22), reply)
    if (!split.ok) {
      throw new Error(split.refusal)
    }
    const assembler = new BridgeReplyAssembler()
    let result
    for (const frame of split.frames) {
      maxFrame = Math.max(maxFrame, Buffer.byteLength(JSON.stringify(frame)))
      result = assembler.accept(frame)
    }
    expect(result).toEqual({ status: 'complete', payload: reply })
    chunks.push(piece.json)
    count++
    cursor = next
    if (piece.nextCursor === null) {
      break
    }
  }
  expect(chunks.join('')).toBe(json)
  expect(JSON.parse(chunks.join(''))).toEqual(item.body)
  const reader = createAgentSessionSettledBodyReader(async (request) => {
    const { sessionId, itemId, ...bodySource } = request
    const reply = await call(
      'agentSession.item',
      { sessionId, itemId, bodySource },
      {
        ...STRUCTURED_MOBILE_CLIENT,
        clientCapabilities: [
          ...STRUCTURED_MOBILE_CLIENT.clientCapabilities,
          AGENT_SESSION_SETTLED_BODY_CAPABILITY
        ]
      },
      {},
      STRUCTURED_AGENT_SESSION_ITEM_METHODS
    )
    if (!reply.ok) {
      throw new Error(JSON.stringify(reply.error))
    }
    return AgentSessionSettledBodyPieceSchema.parse(reply.result)
  })
  const stop = reader.subscribe(source, () => {})
  try {
    await vi.waitFor(() => expect(reader.getSnapshot(source).status).toBe('ready'))
    const recovered = reader.getSnapshot(source)
    if (recovered.status !== 'ready') {
      throw new Error('Missing saved body')
    }
    expect(recovered.body).toEqual(item.body)
    expect(nativeChatReceiptAnswers(recovered.body)).toEqual(nativeChatReceiptAnswers(item.body))
    if (item.body.form.fields[0]?.schema.enum) {
      expect(nativeChatReceiptAnswers(recovered.body)[0]?.answer).toBe('Blue label')
    }
  } finally {
    stop()
    reader.dispose()
  }

  const descriptorBytes = Buffer.byteLength(JSON.stringify(settledBodyPresentation(item, true)))
  expect(descriptorBytes).toBeLessThanOrEqual(2048)
  process.stdout.write(
    `${JSON.stringify({
      bodyCertificate: true,
      E,
      R,
      C,
      F: Buffer.byteLength(JSON.stringify(item)),
      X,
      K: X - E - C,
      descriptorBytes,
      units: json.length,
      count,
      maxJ,
      maxLegacy,
      maxV2,
      maxFrame
    })}\n`
  )
}

it('certifies twenty actual large-description form cancellations in their composed settlement group', async () => {
  const state = hostTestState()
  await attach()
  setStructuredAgentSessionHost(state.host)
  const codex = fakeCodex()
  adapter = adapterFor(codex, { resumeThreadId: THREAD })
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor(SESSION),
    fence: state.store.getRecord(SESSION)!.lease.runtimeFence,
    spawnToken: 'spawn-a',
    events: state.acquire.mock.calls.at(-1)![0].events
  })
  for (let id = 0; id < 20; id++) {
    const params = {
      threadId: THREAD,
      turnId: 'turn-1',
      mode: 'form',
      message: 'Enter values',
      requestedSchema: {
        type: 'object',
        properties: { value: { type: 'string', description: 'd'.repeat(30000) } },
        required: ['value']
      }
    }
    expect(readCodexMcpElicitation(params)).not.toBeNull()
    codex.connections[0].handlers.onServerRequest?.({
      id,
      method: 'mcpServer/elicitation/request',
      params
    })
  }
  await state.host.flushStreamedEvents(SESSION)
  const journal = state.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  expect(journal.snapshot().items.filter((item) => item.body.kind === 'approval')).toHaveLength(20)
  const pending = journal.snapshot().items.filter((item) => item.body.kind === 'approval')
  const beforeGroup = journal.cursor()
  codex.connections[0].handlers.onNotification?.('turn/completed', {
    threadId: THREAD,
    turn: { id: 'turn-1', status: 'completed' }
  })
  await state.host.flushStreamedEvents(SESSION)
  const grouped = journal.cursor()
  const items = journal.snapshot().items.filter((item) => item.body.kind === 'approval')
  expect(
    items.every(
      (item) => item.body.kind === 'approval' && item.body.resolution.state === 'cancelled'
    )
  ).toBe(true)
  const descriptors = items.map((item) => settledBodyPresentation(item, true))
  const events: AgentSessionSubscribeEvent[] = []
  const dispose = await hostTestState().host.subscribe({
    id: 'composed-certificate',
    sessionId: SESSION,
    boundedFrames: true,
    readsCurrentRequests: true,
    readsSettledBodies: true,
    emit: (event) => events.push(event)
  })
  const snapshot = events.find((event) => event.type === 'snapshot')
  if (snapshot?.type !== 'snapshot') {
    throw new Error('Missing snapshot')
  }
  const compact = snapshot
  expect(snapshot.page.items.filter((item) => item.settledBody)).toHaveLength(20)
  for (const item of items) {
    await certifyBody(item, journal, 0, 0)
  }
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(640 * 1024)
  expect(grouped.sequence).toBe(beforeGroup.sequence + 1)
  expect(items.every((item, index) => item.revision === pending[index]!.revision + 1)).toBe(true)
  const maxIdentity = agentJournalItemKey(
    codexPromptIdentity({ threadId: THREAD, promptKey: 'x'.repeat(256) })
  )
  const child = {
    ...descriptors[0]!,
    itemId: maxIdentity,
    agentId: THREAD,
    parentAgentId: THREAD,
    producerKind: 'agent',
    attempt: Number.MAX_SAFE_INTEGER,
    turnScope: { kind: 'turn', turnItemId: maxIdentity },
    revision: Number.MAX_SAFE_INTEGER,
    sequence: Number.MAX_SAFE_INTEGER,
    sequenceIndex: 199
  }
  expect(Buffer.byteLength(JSON.stringify(child))).toBeLessThanOrEqual(2048)
  process.stdout.write(
    `${JSON.stringify({
      composed: true,
      count: items.length,
      F: Buffer.byteLength(JSON.stringify(items)),
      compactPage: Buffer.byteLength(JSON.stringify(compact)),
      childDescriptor: Buffer.byteLength(JSON.stringify(child)),
      itemIdUnits: maxIdentity.length,
      epoch: journal.cursor().epoch,
      providerResponses: codex.connections[0].replies.length
    })}\n`
  )
  dispose()
})
