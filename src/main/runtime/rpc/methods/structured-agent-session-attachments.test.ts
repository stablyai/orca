import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import {
  AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY,
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher writes serialized RpcResponse frames.
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
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
