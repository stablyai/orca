import type { RpcResponse } from '../../../core'

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

import { RpcDispatcher } from '../../../dispatcher'

import { AgentSessionAttachmentStore } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS } from './structured-agent-session-attachments'

import {
  clearStructuredHostStub,
  installStructuredHostStub
} from '../protocol/structured-agent-session-rpc.test-fixture'

import { STRUCTURED_CLIENT } from '../protocol/structured-agent-session-rpc-client.test-fixture'

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
})
