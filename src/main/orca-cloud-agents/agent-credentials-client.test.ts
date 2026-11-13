import { describe, expect, it } from 'vitest'
import {
  agentCredentialsFailureCode,
  createAgentCredentialsClient
} from './agent-credentials-client'

const TOKEN = `sk-ant-oat01-${'Q'.repeat(80)}`
const VIEW = {
  claude: { state: 'active', label: 'a@acme.dev', expiresAt: 1_800_000_000_000 },
  codex: { state: 'none' },
  providerEnabled: { claude: true, codex: true }
}

type Seen = { method: string; url: string; body: string | null }

function fakeControlPlane(respond: (seen: Seen) => Response) {
  const seen: Seen[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : null
    }
    seen.push(request)
    return respond(request)
  }
  const client = createAgentCredentialsClient({
    baseUrl: 'https://control.test',
    getAccessToken: async () => 'tok',
    fetch: fetchImpl
  })
  return { client, seen }
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

describe('createAgentCredentialsClient', () => {
  it('reads the credentials and stores a Claude token with its label', async () => {
    const { client, seen } = fakeControlPlane(() => Response.json(VIEW))
    expect((await client.credentials()).claude.state).toBe('active')
    await client.putClaude(TOKEN, 'a@acme.dev')
    expect(seen[1]).toEqual({
      method: 'PUT',
      url: 'https://control.test/v1/agent-credentials/claude',
      body: JSON.stringify({ token: TOKEN, label: 'a@acme.dev' })
    })
  })

  it('reads an unknown credential state as none instead of failing', async () => {
    const { client } = fakeControlPlane(() =>
      Response.json({ ...VIEW, codex: { state: 'paused' } })
    )
    expect((await client.credentials()).codex.state).toBe('none')
  })

  it('maps server refusals to codes, and no error carries the token', async () => {
    const answers: [number, unknown][] = [
      [400, { error: 'invalid_request', reason: 'invalid_token' }],
      [404, { error: 'not_found' }],
      [409, { error: 'broker_in_progress' }],
      [429, { error: 'rate_limited' }],
      [502, { error: 'broker_unavailable' }],
      [502, { error: 'device_auth_disabled' }],
      [503, { error: 'no_golden_image' }],
      [503, { error: 'not_configured' }],
      [401, { error: 'unauthorized' }]
    ]
    const { client } = fakeControlPlane(() => {
      const [status, body] = answers.shift()!
      return Response.json(body, { status })
    })
    const codes: string[] = []
    for (let i = 0; i < 9; i++) {
      const error = await failure(() =>
        i < 2 ? client.putClaude(TOKEN) : client.startCodexBroker()
      )
      expect(JSON.stringify(error)).not.toContain(TOKEN)
      expect(error instanceof Error ? error.message : '').not.toContain(TOKEN)
      codes.push(agentCredentialsFailureCode(error))
    }
    expect(codes).toEqual([
      'invalid_token',
      'not_found',
      'broker_in_progress',
      'rate_limited',
      'broker_unavailable',
      'device_auth_disabled',
      'no_golden_image',
      'not_configured',
      'signed_out'
    ])
  })

  it('drives the Codex broker routes and refuses an odd broker id', async () => {
    const replies = [
      {
        brokerId: 'brk_1',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
        expiresAt: 5
      },
      { status: 'pending' },
      { status: 'failed' }
    ]
    const { client, seen } = fakeControlPlane(() => Response.json(replies.shift()))
    expect((await client.startCodexBroker()).userCode).toBe('ABCD-1234')
    expect((await client.codexBrokerStatus('brk_1')).status).toBe('pending')
    await client.cancelCodexBroker('brk_1')
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'POST /v1/agent-credentials/codex/broker',
      'GET /v1/agent-credentials/codex/broker/brk_1',
      'DELETE /v1/agent-credentials/codex/broker/brk_1'
    ])
    await expect(client.codexBrokerStatus('../secrets')).rejects.toThrow()
    await expect(client.cancelCodexBroker('..')).rejects.toThrow()
  })

  it('never maps an inherited property name to a code', async () => {
    const { client } = fakeControlPlane(() =>
      Response.json({ error: 'constructor' }, { status: 500 })
    )
    expect(agentCredentialsFailureCode(await failure(() => client.credentials()))).toBe(
      'unavailable'
    )
  })

  it('writes the default Source', async () => {
    const { client, seen } = fakeControlPlane(() =>
      Response.json({
        defaults: { claude: 'sign-in' },
        coveredByKey: { claude: true, codex: false }
      })
    )
    await client.setDefaultSource('claude', 'sign-in')
    expect(seen[0]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ agent: 'claude', source: 'sign-in' })
    })
  })

  it('reads and writes one workspace’s Source by its sandbox id', async () => {
    const { client, seen } = fakeControlPlane(() =>
      Response.json({
        defaults: {},
        effective: { codex: { source: 'key' } },
        coveredByKey: { claude: false, codex: true },
        sharedWorkspace: false
      })
    )
    const read = await client.sources(undefined, 'sbx_41d9')
    expect(read.effective?.codex?.source).toBe('key')
    await client.setWorkspaceSource('codex', 'key', 'sbx_41d9')
    expect(seen[0]?.url).toContain('/v1/agent-sources?workspaceId=sbx_41d9')
    expect(seen[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ agent: 'codex', source: 'key', workspaceId: 'sbx_41d9' })
    })
  })
})
