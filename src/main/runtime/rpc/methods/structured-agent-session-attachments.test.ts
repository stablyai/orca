import {
  AttachmentTextSource,
  type AttachmentTextChunk
} from '../../../../shared/attachment-text-source'
import {
  remoteRpcContentBudget,
  REMOTE_RPC_MAX_CONTENT_BYTES
} from '../../../../shared/remote-rpc-content-budget'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../../shared/agent-session-runtime-capabilities'
import { RUNTIME_CAPABILITIES as runtimeCapabilities } from '../../../../shared/protocol-version'
import '../unused-default-rpc-methods.test-fixture'
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import {
  AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY,
  AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import { AgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS } from './structured-agent-session-attachments'
import { isMobileE2EETextPayloadWithinLimit } from '../mobile-e2ee-outbound-admission'
import {
  clearStructuredHostStub,
  installStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

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
  it('is advertised, so a client can tell a host with the store from an older one', () => {
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY)
  })

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

  it('refuses a client that cannot read structured sessions', async () => {
    const response = await call(
      'agentSessionAttachment.uploadStart',
      { sessionId: 'session-alpha', name: 'shot.png', byteLength: 3 },
      { clientKind: 'runtime', clientCapabilities: [] }
    )
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
  })

  it('refuses a declared size over the attachment limit before storing anything', async () => {
    const response = await call(
      'agentSessionAttachment.uploadStart',
      { sessionId: 'session-alpha', name: 'big.bin', byteLength: 51 * 1024 * 1024 },
      CLIENT_A
    )
    expect(response.ok).toBe(false)
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

  it('refuses an upload for a chat this host does not hold', async () => {
    const response = await call(
      'agentSessionAttachment.uploadStart',
      { sessionId: 'session-elsewhere', name: 'a.txt', byteLength: 1 },
      CLIENT_A
    )
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('not on this host') }
    })
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
  const bytes = Buffer.from(['\ufeffstart\r\n', '🙂\\\"\n'.repeat(60_000), 'end'].join(''))
  const path = await uploadBytes('picked source.log', bytes)
  const source = new AttachmentTextSource(path, async (request) => {
    const reply = await call('agentSessionAttachment.readTextChunk', request, {
      ...CLIENT_A,
      clientKind: 'mobile'
    })
    expect(isMobileE2EETextPayloadWithinLimit(JSON.stringify(reply))).toBe(true)
    return result(reply)
  })
  expect((await source.page(0)).segments.join('')).toMatch(/^\ufeffstart\r\n/)
  expect(await source.copyText()).toBe(bytes.toString('utf8'))
  const saved: Uint8Array[] = []
  for await (const chunk of source.bytes()) {
    saved.push(chunk)
  }
  expect(Buffer.concat(saved)).toEqual(bytes)
  const snapshot = source.snapshot
  await writeFile(path, Buffer.alloc(bytes.length, 97))
  expect(
    await call(
      'agentSessionAttachment.readTextChunk',
      { path, offset: 0, length: 10, expectedSnapshot: snapshot },
      CLIENT_A
    )
  ).toMatchObject({ ok: false })
})

it('keeps the store boundary, regular-file checks, range limit and request-id budget on the actual reader', async () => {
  const path = await uploadBytes('attached.txt', Buffer.alloc(300_000, 97))
  expect(runtimeCapabilities).toContain(AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY)
  const read = (filePath: string) => store.readTextChunk({ path: filePath, offset: 0, length: 10 })
  await expect(read(join(root, 'outside.txt'))).rejects.toThrow()
  await expect(
    read(join(store.rootDir, '12345678-1234-1234-1234-123456789abc', '.upload.part'))
  ).rejects.toThrow()
  await expect(store.readTextChunk({ path, offset: 0, length: 256 * 1024 + 1 })).rejects.toThrow()
  await expect(
    store.readTextChunk(
      { path, offset: 0, length: 256 * 1024 },
      remoteRpcContentBudget('x'.repeat(REMOTE_RPC_MAX_CONTENT_BYTES - 100))
    )
  ).rejects.toThrow('reply is too large')
  const alias = join(path, '..', 'alias.txt')
  const outside = join(root, 'outside.txt')
  await writeFile(outside, 'private')
  await symlink(outside, alias)
  await expect(read(alias)).rejects.toThrow()
  const directory = join(path, '..', 'directory')
  await mkdir(directory)
  await expect(read(directory)).rejects.toThrow()
  const raw = result<AttachmentTextChunk>(
    await call(
      'agentSessionAttachment.readTextChunk',
      { path, offset: 0, length: 256 * 1024 },
      { ...CLIENT_A, clientKind: 'mobile' }
    )
  )
  expect(raw.bytesRead).toBe(256 * 1024)
  expect(raw.eof).toBe(false)
  expect(
    await call(
      'agentSessionAttachment.readTextChunk',
      { path, offset: 0, length: 10 },
      { clientKind: 'runtime', clientCapabilities: [] }
    )
  ).toMatchObject({ ok: false })
})
