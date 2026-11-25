import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import { SharedBotHosts } from '../../bots/shared-with-me/shared-bot-hosts'
import { memorySharedBotHomes } from '../../bots/shared-with-me/shared-bot-home.test-fixture'
import { routeSharedHostsThrough } from '../runtime-environments/requests/runtime-environment-shared-hosts'
import {
  isBotShareMethod,
  isBotShareStreamMethod
} from '../../runtime/rpc/methods/rpc-method-share'
import nacl from 'tweetnacl'
import { openBotTeamShareHeldMessage } from '../../../shared/bots/bot-team-share-seal'
import { SHARED_BOT_HOST_ERRORS } from '../../../shared/bots/shared-bot-hosts'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import type { ConnectorShareHoldRequest } from '../../../shared/connector-share-contract'
import {
  resolveAttachmentEnvironmentId,
  uploadBufferToAgentSessionAttachments
} from './agent-session-attachment-upload'

// Every paired-server path starts by resolving its selector in the registry.
const paired = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: paired.resolve
}))

const dirs: string[] = []
afterEach(() => {
  routeSharedHostsThrough(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const HOST = nacl.box.keyPair()
const HOST_KEY = Buffer.from(HOST.publicKey).toString('base64')

async function awayHost(hostKey?: string) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'shared-attachments-'))
  dirs.push(userDataPath)
  const holds: ConnectorShareHoldRequest[] = []
  const hosts = new SharedBotHosts({
    userDataPath,
    account: () => 'ada',
    homes: memorySharedBotHomes(userDataPath).homes,
    platform: NODE_RELAY_CLIENT_PLATFORM,
    cloud: () => ({
      mine: async () => ({
        ok: true,
        value: {
          v: 1,
          shares: [
            {
              shareId: 'share-1',
              botId: 'bot-1',
              botName: 'Ivy',
              ownerName: 'Jinwoo Hong',
              hostOnline: false,
              state: 'ready',
              ...(hostKey ? { hostKey } : {}),
              held: []
            }
          ]
        }
      }),
      accept: async () => ({ ok: true, value: { status: 'queued' } }),
      hold: async (_shareId, request) => {
        holds.push(request)
        return { ok: true, value: { status: 'held' } }
      }
    }),
    publish: () => {}
  })
  routeSharedHostsThrough({
    hosts,
    methods: { allows: isBotShareMethod, streams: isBotShareStreamMethod }
  })
  await hosts.refresh()
  hosts.stop()
  return { hosts, userDataPath, holds }
}

describe('attachment uploads to a shared agent’s host', () => {
  it('go through runtimeEnvironments to its share link, never the paired-server registry', async () => {
    const { hosts, userDataPath } = await awayHost()
    const environmentId = hosts.views()[0]!.environmentId
    expect(await resolveAttachmentEnvironmentId(userDataPath, environmentId)).toBe(environmentId)
    // Its owner's computer is away, so the share link answers; the paired registry is never asked.
    await expect(
      uploadBufferToAgentSessionAttachments(
        { environmentId, sessionId: 'chat-0001', expectedEnvironmentRuntimeId: 'r', userDataPath },
        'shot.png',
        Buffer.from('png')
      )
    ).rejects.toThrow('Jinwoo Hong’s computer is offline')
    expect(paired.resolve).not.toHaveBeenCalled()
  })

  it('are kept here for a chat whose message will be held, and sealed into that message', async () => {
    const { hosts, userDataPath, holds } = await awayHost(HOST_KEY)
    const environmentId = hosts.views()[0]!.environmentId
    const upload = {
      environmentId,
      sessionId: 'chat-0001',
      expectedEnvironmentRuntimeId: 'r',
      userDataPath
    }
    const stored = await uploadBufferToAgentSessionAttachments(
      upload,
      'shot.png',
      Buffer.from('png bytes')
    )
    const sent = await hosts.call(
      environmentId,
      'agentSession.send',
      structuredAgentSessionMessageSendMutation({
        sessionId: 'chat-0001',
        clientOperationId: 'm1',
        expectedRuntimeFence: null,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [
            { type: 'text', text: 'See this' },
            { type: 'image-ref', path: stored.path }
          ]
        }
      })
    )
    expect(sent.ok ? null : sent.error.code).toBe(SHARED_BOT_HOST_ERRORS.held)
    const opened = openBotTeamShareHeldMessage(NODE_PAIRED_E2EE_PRIMITIVES, {
      hostSecretKey: HOST.secretKey,
      hostKey: HOST_KEY,
      sealed: holds[0]!.sealed,
      expect: { shareId: 'share-1', botId: 'bot-1', clientMessageId: 'm1' }
    })
    expect(opened?.text).toBe('See this')
    expect(opened?.attachments).toEqual([
      { name: 'shot.png', contentBase64: Buffer.from('png bytes').toString('base64') }
    ])
    // Past one held message's budget it is refused before a byte is kept.
    await expect(
      uploadBufferToAgentSessionAttachments(upload, 'big.bin', Buffer.alloc(800 * 1024))
    ).rejects.toThrow('Too large to hold')
    expect(paired.resolve).not.toHaveBeenCalled()
  })
})
