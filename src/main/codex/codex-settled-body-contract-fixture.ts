import { expect, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES as M } from '../../shared/remote-runtime/remote-runtime-memory-limits'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  settledBodyPresentation,
  readSettledBodyPiece
} from '../native-chat/agent-session-wire/agent-session-settled-body'
import { encrypt } from '../../shared/e2ee-crypto'
import { sealMobileE2EEV2Frame } from '../../shared/mobile-e2ee-v2-framing'
import {
  splitBridgeReply,
  BridgeReplyAssembler
} from '../../../mobile/src/mobile-web-shell/bridge/bridge-reply-chunking'
import { createAgentSessionSettledBodyReader } from '../../shared/agent-session-settled-body-reader'
import {
  call,
  STRUCTURED_MOBILE_CLIENT
} from '../runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import {
  AGENT_SESSION_SETTLED_BODY_CAPABILITY,
  AgentSessionSettledBodyPieceSchema
} from '../../shared/agent-session-settled-body'
import { STRUCTURED_AGENT_SESSION_ITEM_METHODS } from '../runtime/rpc/methods/structured-agent-session-item'
import { nativeChatReceiptAnswers } from '../../shared/native-chat-resolution-receipt'

export async function certifyBody(
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
