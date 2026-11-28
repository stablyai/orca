// A paired Orca's upload for one of this computer's bots (`send --on --to bot:<name> --file`).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentSessionAttachmentStore } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'
import type { RpcContext } from '../../../core'
import { STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS } from './structured-agent-session-attachments'

const upload = STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS.find(
  (method) => method.name === 'agentSessionAttachment.uploadStart'
)!
const bot = makeTestBot({ name: 'Docs' })
let dir: string
let store: AgentSessionAttachmentStore

function asCaller(caller: Record<string, unknown>): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the caller and the runtime ports the upload gate reads.
  return {
    caller,
    pairedDeviceId: 'device_a',
    runtime: {
      ensureStructuredAgentSessionHost: async () => {},
      bots: { list: () => [bot], assertEnabled: () => {} }
    }
  } as unknown as RpcContext
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-bot-upload-'))
  store = new AgentSessionAttachmentStore(dir, { hasSession: () => false })
  setAgentSessionAttachmentStore(store)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate only checks that a host is installed.
  setStructuredAgentSessionHost({ deps: {} } as unknown as StructuredAgentSessionHost)
})

afterEach(() => {
  setStructuredAgentSessionHost(null)
  setAgentSessionAttachmentStore(null)
  rmSync(dir, { recursive: true, force: true })
})

it('stages a paired Orca upload for a bot here, by name or id, and refuses an unknown bot', async () => {
  const owner = asCaller({ kind: 'paired-device', deviceId: 'device_a' })
  for (const name of ['docs', bot.id]) {
    const params = upload.params.parse({ bot: name, name: 'notes.txt', byteLength: 0 })
    const { uploadId } = await upload.handler(params, owner)
    const { path } = await store.commitUpload({ callerKey: 'device_a', uploadId })
    expect(path.startsWith(dir)).toBe(true)
  }
  const unknown = upload.params.parse({ bot: 'Nobody', name: 'notes.txt', byteLength: 0 })
  await expect(upload.handler(unknown, owner)).rejects.toThrow('This computer has no bot Nobody')
})

it("refuses a bot's own agent the owner's upload target", async () => {
  const agent = asCaller({ kind: 'paired-device', deviceId: 'bot-cli', agent: true })
  const params = upload.params.parse({ bot: 'Docs', name: 'notes.txt', byteLength: 0 })
  await expect(upload.handler(params, agent)).rejects.toThrow('Only your owner')
})
