import * as fs from 'node:fs/promises'
import type { RpcResponse } from '../core'
import { RUNTIME_CAPABILITIES as runtimeCapabilities } from '../../../../shared/protocol-version'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import {
  AttachmentTextSource,
  ATTACHMENT_TEXT_BLOCK_BYTES,
  type AttachmentTextRequest
} from '../../../../shared/attachment-text-source'
import { AttachmentTextViewport } from '../../../../shared/attachment-text-viewport'

import '../unused-default-rpc-methods.test-fixture'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'

import { RpcDispatcher } from '../dispatcher'

import { AgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS } from './structured-agent-session-attachments'
import { isMobileE2EETextPayloadWithinLimit } from '../mobile-e2ee-outbound-admission'
import {
  clearStructuredHostStub,
  installStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return {
    ...original,
    open: vi.fn(original.open),
    stat: vi.fn(original.stat),
    realpath: vi.fn(original.realpath)
  }
})

let root: string
let store: AgentSessionAttachmentStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-attachment-rpc-'))
  store = new AgentSessionAttachmentStore(join(root, 'agent-session-attachments'), {
    hasSession: (sessionId) => sessionId === 'session-alpha'
  })
  setAgentSessionAttachmentStore(store)
  installStructuredHostStub()
})

afterEach(async () => {
  store.clearInFlightForTests()
  setAgentSessionAttachmentStore(null)
  clearStructuredHostStub()
  await rm(root, { recursive: true, force: true })
})

async function call(
  method: string,
  params: unknown,
  client: { clientId?: string; clientKind?: 'runtime' | 'mobile'; clientCapabilities?: string[] }
): Promise<RpcResponse> {
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attachment methods read only the host-install hook and runtime id.
    runtime: {
      getRuntimeId: () => 'runtime-1',
      ensureStructuredAgentSessionHost: async () => {}
    } as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS
  })
  const replies: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    { id: 'request-1', authToken: 'token', method, params },
    (raw) => replies.push(JSON.parse(raw)),
    client
  )
  if (!replies[0]) {
    throw new Error(`no reply for ${method}`)
  }
  return replies[0]
}

function result<T>(response: RpcResponse): T {
  if (!response.ok) {
    throw new Error(`refused: ${JSON.stringify(response)}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each caller names the result shape its method returns.
  return response.result as T
}

const CLIENT_A = { ...STRUCTURED_CLIENT, clientId: 'client-a' }

async function uploadBytes(name: string, bytes: Buffer): Promise<string> {
  const { uploadId } = result<{ uploadId: string }>(
    await call(
      'agentSessionAttachment.uploadStart',
      { sessionId: 'session-alpha', name, byteLength: bytes.byteLength },
      CLIENT_A
    )
  )
  const chunk = 384 * 1024
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    result(
      await call(
        'agentSessionAttachment.uploadAppend',
        {
          uploadId,
          offset,
          contentBase64: bytes.subarray(offset, offset + chunk).toString('base64')
        },
        CLIENT_A
      )
    )
  }
  return result<{ path: string }>(
    await call('agentSessionAttachment.uploadCommit', { uploadId }, CLIENT_A)
  ).path
}

describe('agentSessionAttachment.*', () => {
  it('stores an upload for the chat and hands back the server path', async () => {
    const { uploadId } = result<{ uploadId: string }>(
      await call(
        'agentSessionAttachment.uploadStart',
        { sessionId: 'session-alpha', name: 'shot.png', byteLength: 3 },
        CLIENT_A
      )
    )
    result(
      await call(
        'agentSessionAttachment.uploadAppend',
        { uploadId, offset: 0, contentBase64: Buffer.from('png').toString('base64') },
        CLIENT_A
      )
    )
    const stored = result<{ path: string; name: string }>(
      await call('agentSessionAttachment.uploadCommit', { uploadId }, CLIENT_A)
    )
    expect(stored.name).toBe('shot.png')
    expect(stored.path.startsWith(store.rootDir)).toBe(true)
    expect(await readFile(stored.path, 'utf8')).toBe('png')

    const preview = await call('agentSessionAttachment.read', { path: stored.path }, CLIENT_A)
    expect(preview).toMatchObject({ ok: true, result: { isBinary: true, mimeType: 'image/png' } })
  })

  it("keeps one client's upload out of another's reach", async () => {
    const { uploadId } = result<{ uploadId: string }>(
      await call(
        'agentSessionAttachment.uploadStart',
        { sessionId: 'session-alpha', name: 'a.txt', byteLength: 1 },
        CLIENT_A
      )
    )
    const response = await call(
      'agentSessionAttachment.uploadCommit',
      { uploadId },
      {
        ...STRUCTURED_CLIENT,
        clientId: 'client-b'
      }
    )
    expect(response).toMatchObject({ ok: false })
    expect(store.isUploadInFlight(uploadId)).toBe(true)
  })

  it('answers a remote preview of an image over 3 MiB with a small refusal, not an oversized reply', async () => {
    const path = await uploadBytes('big.png', Buffer.alloc(3.5 * 1024 * 1024, 7))
    const replies: string[] = []
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attachment methods read only the host-install hook and runtime id.
      runtime: {
        getRuntimeId: () => 'runtime-1',
        ensureStructuredAgentSessionHost: async () => {}
      } as unknown as OrcaRuntimeService,
      methods: STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS
    })
    await dispatcher.dispatchStreaming(
      {
        id: 'request-big',
        authToken: 'token',
        method: 'agentSessionAttachment.read',
        params: { path }
      },
      (raw) => replies.push(raw),
      { ...CLIENT_A, clientKind: 'runtime' }
    )
    expect(replies).toHaveLength(1)
    expect(isMobileE2EETextPayloadWithinLimit(replies[0] ?? '')).toBe(true)
    expect(JSON.parse(replies[0] ?? '{}')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('file_too_large') }
    })
  })
})

it('reads a committed text attachment through the registered mobile RPC and validates its complete snapshot', async () => {
  const prefix = '\ufeffstart\r\nmiddle\rlast\n'
  const bytes = Buffer.from(
    [
      prefix,
      'a'.repeat(ATTACHMENT_TEXT_BLOCK_BYTES - Buffer.byteLength(prefix) - 1),
      '\r\n',
      'é🙂\r\n'.repeat(125_000),
      'end'
    ].join('')
  )
  const path = await uploadBytes('picked source.log', bytes)
  let ranges = 0
  const source = new AttachmentTextSource(path, async (request) => {
    ranges++
    const reply = await call('agentSessionAttachment.readTextChunk', request, {
      ...CLIENT_A,
      clientKind: 'mobile'
    })
    expect(isMobileE2EETextPayloadWithinLimit(JSON.stringify(reply))).toBe(true)
    return result(reply)
  })
  expect(runtimeCapabilities).toContain(AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY)
  expect(MOBILE_RPC_METHOD_ALLOWLIST.has('agentSessionAttachment.readTextChunk')).toBe(true)
  await expect(store.readTextChunk({ path, offset: 0, length: 256 * 1024 + 1 })).rejects.toThrow()
  await expect(
    store.readTextChunk({ path: join(root, 'outside.txt'), offset: 0, length: 10 })
  ).rejects.toThrow()
  vi.mocked(fs.open).mockClear()
  vi.mocked(fs.stat).mockClear()
  vi.mocked(fs.realpath).mockClear()
  expect((await source.block(0)).join('')).toMatch(/^\ufeffstart\nmiddle\nlast\n/)
  expect((await source.block(1))[0]?.startsWith('é🙂')).toBe(true)
  expect(await source.copyText()).toBe(bytes.toString('utf8'))
  const saved: Uint8Array[] = []
  for await (const chunk of source.bytes()) {
    saved.push(chunk)
  }
  expect(Buffer.concat(saved)).toEqual(bytes)
  expect(ranges).toBe(2 + 2 * Math.ceil(bytes.length / (256 * 1024)))
  expect(fs.open).toHaveBeenCalledTimes(ranges)
  expect(vi.mocked(fs.stat).mock.calls.length).toBeLessThanOrEqual(4 * ranges)
  expect(vi.mocked(fs.realpath).mock.calls.length).toBeLessThanOrEqual(8 * ranges)
  const snapshot = source.snapshot
  await writeFile(path, Buffer.alloc(bytes.length, 97))
  expect(
    await call(
      'agentSessionAttachment.readTextChunk',
      { path, offset: 0, length: 10, expectedSnapshot: snapshot },
      CLIENT_A
    )
  ).toMatchObject({ ok: false })
  source.dispose()
  {
    const bytes = Buffer.from(
      `\ufeff${'a'.repeat(ATTACHMENT_TEXT_BLOCK_BYTES - 4)}🙂é\r\n${'x'.repeat(25 * 1024 * 1024)}${'\n'.repeat(ATTACHMENT_TEXT_BLOCK_BYTES * 2)}TAIL`
    )
    const requests: AttachmentTextRequest[] = []
    let hold: Promise<void> | undefined
    let started = Promise.withResolvers<void>()
    const path = await uploadBytes('scroll-source.log', bytes)
    const source = new AttachmentTextSource(path, async (request) => {
      requests.push(request)
      started.resolve()
      await hold
      return result(
        await call('agentSessionAttachment.readTextChunk', request, {
          ...CLIENT_A,
          clientKind: 'mobile'
        })
      )
    })

    const first = await source.block(0)
    const pinnedSnapshot = source.snapshot
    expect(requests).toHaveLength(1)
    const second = await source.block(1)
    expect(
      (first.join('') + second.join('')).startsWith(
        `\ufeff${'a'.repeat(ATTACHMENT_TEXT_BLOCK_BYTES - 4)}🙂é\n`
      )
    ).toBe(true)
    await source.block(source.blockCount - 2)
    await source.block(source.blockCount - 1)
    expect(source.cachedBlock(0)).toBeUndefined()
    expect(source.cachedBlock(1)).toBeUndefined()
    const layout = new AttachmentTextViewport(source, 20, 600)
    expect(layout.total).toBeLessThan(8_000_000)
    const end = layout.rows(layout.total - 600)
    expect(end.length).toBeLessThanOrEqual(256)
    expect(end.at(-1)?.text).toBe('TAIL')
    expect(end.every((row) => Array.from(row.text).length <= 256)).toBe(true)
    // Evicted ranges remain reachable; viewport storms replace pending work rather than serially enqueuing it.
    const release = Promise.withResolvers<void>()
    hold = release.promise
    started = Promise.withResolvers<void>()
    const obsolete: unknown[] = [],
      published: unknown[] = []
    source.requestViewport([3], (error) => obsolete.push(error))
    await started.promise
    const before = requests.length
    for (let block = 4; block < 104; block++) {
      source.requestViewport([block], (error) => obsolete.push(error))
    }
    const ready = Promise.withResolvers<void>()
    source.requestViewport([0, 1], (error) => {
      published.push(error)
      ready.resolve()
    })
    hold = undefined
    release.resolve()
    await ready.promise
    expect(obsolete).toEqual([])
    expect(published).toEqual([undefined])
    expect(requests.length - before).toBe(2)
    expect(source.cachedBlock(0)?.join('')).toBe(first.join(''))
    expect(source.cachedBlock(1)?.join('')).toBe(second.join(''))
    expect(requests.every((request) => request.length <= 16 * 1024)).toBe(true)
    expect(requests.slice(1).every((request) => request.expectedSnapshot === pinnedSnapshot)).toBe(
      true
    )
    const output: Uint8Array[] = []
    for await (const chunk of source.bytes()) {
      output.push(chunk)
    }
    expect(Buffer.concat(output).equals(bytes)).toBe(true)
    await expect(source.copyText()).rejects.toThrow('too large')
    started = Promise.withResolvers<void>()
    const late = Promise.withResolvers<void>()
    hold = late.promise
    const pending = source.block(4)
    await started.promise
    source.dispose()
    late.resolve()
    await expect(pending).rejects.toThrow()
    expect(source.cachedBlock(4)).toBeUndefined()
  }
})
