import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import { SharedBotHosts } from '../../bots/shared-with-me/shared-bot-hosts'
import { setSharedBotHostRouting } from '../../bots/shared-with-me/shared-bot-host-routing'
import {
  resolveAttachmentEnvironmentId,
  uploadBufferToAgentSessionAttachments
} from './agent-session-attachment-upload'

const paired = vi.hoisted(() => ({ call: vi.fn(), resolve: vi.fn() }))
vi.mock('../runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: paired.call
}))
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: paired.resolve
}))

const dirs: string[] = []
afterEach(() => {
  setSharedBotHostRouting(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('attachment uploads to a shared agent’s host', () => {
  it('go through its share link, never the paired-server registry', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'shared-attachments-'))
    dirs.push(userDataPath)
    const hosts = new SharedBotHosts({
      userDataPath,
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
                held: []
              }
            ]
          }
        }),
        accept: async () => ({ ok: true, value: { status: 'queued' } }),
        hold: async () => ({ ok: true, value: { status: 'held' } })
      }),
      publish: () => {}
    })
    setSharedBotHostRouting(hosts)
    await hosts.refresh()
    hosts.stop()
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
    expect(paired.call).not.toHaveBeenCalled()
    expect(paired.resolve).not.toHaveBeenCalled()
  })
})
