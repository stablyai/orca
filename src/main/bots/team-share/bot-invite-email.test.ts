import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import { OrcaCloudRequestError } from '../../orca-profiles/cloud-auth/profile-cloud-client'
import { botInviteEmail, postBotInvite } from './bot-invite-email'

const invite = { to: 'alice@example.com', agentName: 'Ada', connectors: [] }

const unlinked: Pick<
  Bot,
  'name' | 'avatar' | 'slack' | 'slackApps' | 'linear' | 'linearWorkspaces' | 'github'
> = { name: 'Ada', avatar: null, slack: null, linear: null, github: null }

function answering(status: number, body?: unknown): typeof fetch {
  return async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })
}

describe('invite email', () => {
  it('is sent only when the cloud says it went out', async () => {
    const config = 'https://auth.example'
    await expect(postBotInvite(config, 't', invite, answering(200, { sent: true }))).resolves.toBe(
      true
    )
    // Log mode and refusals.
    await expect(
      postBotInvite(config, 't', invite, answering(200, { sent: false, reason: 'logged' }))
    ).resolves.toBe(false)
    // Its hourly limit: the share stands and the row says Email not sent yet.
    await expect(
      postBotInvite(config, 't', invite, answering(429, { error: 'rate_limited' }))
    ).resolves.toBe(false)
    // An older cloud with no invite route.
    await expect(postBotInvite(config, 't', invite, answering(404))).resolves.toBe(false)
  })

  it('throws on a rejected token, so the session refreshes', async () => {
    await expect(
      postBotInvite('https://auth.example', 't', invite, answering(401))
    ).rejects.toBeInstanceOf(OrcaCloudRequestError)
  })

  it('posts the email, agent name and a fresh request id with the token', async () => {
    const sent: Request[] = []
    const capture: typeof fetch = async (url, init) => {
      sent.push(new Request(url, init))
      return new Response(JSON.stringify({ sent: true }), { status: 200 })
    }
    await postBotInvite('https://auth.example', 'token-1', invite, capture)
    expect(sent[0]?.url).toBe('https://auth.example/v1/desktop/agent-invites')
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer token-1')
    const body = await sent[0]?.json()
    expect(body).toMatchObject(invite)
    expect(body.requestId).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  })

  it("names the bot's mascot, never an uploaded or emoji picture", () => {
    expect(botInviteEmail({ ...unlinked, avatar: 'mascot:G1' }, 'a@example.com')).toEqual({
      to: 'a@example.com',
      agentName: 'Ada',
      avatar: 'mascot:G1',
      connectors: []
    })
    for (const avatar of ['upload:7', '🐙', 'mascot:Z9', null]) {
      expect(botInviteEmail({ ...unlinked, avatar }, 'a@example.com')).not.toHaveProperty('avatar')
    }
  })

  it('lists the services the bot answers on, Slack, GitHub then Linear', () => {
    const slack = { appId: 'A1', teamId: 'T1', ownerUserId: 'u1' }
    const linear = { workspaceId: 'w1', workspaceName: 'Acme', urlKey: 'acme', ownerUserId: 'u1' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the link's presence is read.
    const linked = {
      ...unlinked,
      slackApps: [slack],
      linearWorkspaces: [linear],
      github: { ownerUserId: 'u1' }
    } as unknown as typeof unlinked
    expect(botInviteEmail(linked, 'a@example.com').connectors).toEqual([
      'slack',
      'github',
      'linear'
    ])
    // A bot saved before several Slack workspaces.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the link's presence is read.
    const legacy = { ...unlinked, slack } as unknown as typeof unlinked
    expect(botInviteEmail(legacy, 'a@example.com').connectors).toEqual(['slack'])
    expect(botInviteEmail(unlinked, 'a@example.com').connectors).toEqual([])
  })
})
