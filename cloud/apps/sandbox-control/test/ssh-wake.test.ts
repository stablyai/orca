import { describe, expect, it } from 'vitest'
import { SSH_START_SCRIPT } from '../src/sandbox-ssh'
import { createHarness } from './harness'

const KEY = `ssh-ed25519 ${'A'.repeat(68)} me@laptop`
const KEY2 = `ssh-ed25519 ${'B'.repeat(68)} other@laptop`

async function setup(org?: string) {
  const h = await createHarness()
  const asAlice = async (method: string, path: string, body?: unknown) =>
    h.call(method, path, { body, bearer: await h.token('alice', org) })
  const { body } = await asAlice('POST', '/v1/sandboxes', { workspaceId: 'ws-1', machineSize: 'standard' })
  const id = body.sandbox.id as string
  const scripts: Record<string, string>[] = []
  h.vercel.onScript = (script) => {
    if (script !== SSH_START_SCRIPT) {
      return undefined
    }
    scripts.push(h.vercel.commands.at(-1)!.env)
    return { exitCode: 0, stdout: '{"ok":true,"user":"ubuntu"}\n', stderr: '' }
  }
  const wake = (secret: string) =>
    h.send(
      new Request(`https://sandbox.test/v1/ssh-wake/${id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        body: '{"wait":true}'
      })
    )
  return { h, id, scripts, wake, asAlice }
}

describe('wake on SSH', () => {
  it('wakes a sleeping VM, starts sshd + bridge, and returns the endpoint, bridge subprotocol and login user', async () => {
    const { h, id, scripts, wake, asAlice } = await setup()
    const res = await asAlice('POST', `/v1/sandboxes/${id}/ssh`, { publicKey: KEY })
    expect(res.status).toBe(200)
    expect(res.body.wakeUrl).toBe(`https://sandbox.test/v1/ssh-wake/${id}`)
    const secret = res.body.wakeSecret as string
    expect(JSON.stringify(h.raw.prepare('SELECT * FROM sandbox_ssh').get())).not.toContain(secret)
    await asAlice('POST', `/v1/sandboxes/${id}/suspend`)
    const answer = await (await wake(secret)).json()
    expect(answer.state).toBe('ready')
    // The bridge token travels as a WebSocket subprotocol, never in the URL.
    expect(answer.endpoint).toMatch(/^wss:\/\/p2222-sb-\d+\.vercel\.run$/)
    expect(answer.protocol).toBe(`orca-bridge.${scripts[0]!.ORCA_SSH_BRIDGE_TOKEN}`)
    expect(answer.user).toBe('ubuntu')
    expect(scripts[0]!.ORCA_SSH_PUBKEY).toBe(KEY)
  })

  it('keeps the bridge token across re-setup (a running bridge keeps working) but rotates the wake secret and key', async () => {
    const { id, scripts, wake, asAlice } = await setup()
    const first = (await asAlice('POST', `/v1/sandboxes/${id}/ssh`, { publicKey: KEY })).body.wakeSecret
    await wake(first)
    const second = (await asAlice('POST', `/v1/sandboxes/${id}/ssh`, { publicKey: KEY2 })).body.wakeSecret
    expect((await wake(first)).status).toBe(401)
    expect((await wake(second)).status).toBe(200)
    expect(scripts.map((env) => env.ORCA_SSH_BRIDGE_TOKEN)).toEqual([scripts[0]!.ORCA_SSH_BRIDGE_TOKEN, scripts[0]!.ORCA_SSH_BRIDGE_TOKEN])
    expect(scripts.at(-1)!.ORCA_SSH_PUBKEY).toBe(KEY2)
  })

  it('only the owner can set up or remove SSH; a teammate in the same account cannot', async () => {
    const { h, id, asAlice } = await setup('team1')
    const bob = await h.token('bob', 'team1')
    expect((await h.call('POST', `/v1/sandboxes/${id}/ssh`, { bearer: bob, body: { publicKey: KEY2 } })).status).toBe(404)
    expect((await h.call('DELETE', `/v1/sandboxes/${id}/ssh`, { bearer: bob })).status).toBe(404)
    expect((await asAlice('POST', `/v1/sandboxes/${id}/ssh`, { publicKey: KEY })).status).toBe(200)
    expect((await h.call('POST', `/v1/sandboxes/${id}/ssh`, { as: 'mallory', body: { publicKey: KEY } })).status).toBe(404)
  })

  it('DELETE revokes: the secret stops working and the VM key block is cleared', async () => {
    const { h, id, scripts, wake, asAlice } = await setup()
    const secret = (await asAlice('POST', `/v1/sandboxes/${id}/ssh`, { publicKey: KEY })).body.wakeSecret
    expect((await asAlice('DELETE', `/v1/sandboxes/${id}/ssh`)).body).toEqual({ removed: true })
    expect(scripts.at(-1)).toMatchObject({ ORCA_SSH_REVOKE: '1' })
    expect(scripts.at(-1)!.ORCA_SSH_PUBKEY).toBeUndefined()
    expect((await wake(secret)).status).toBe(401)
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM sandbox_ssh').get()).toEqual({ n: 0 })
  })

  it('refuses a wake when the owner lost access, but not for a capacity limit', async () => {
    const { h, id, wake, asAlice } = await setup()
    const secret = (await asAlice('POST', `/v1/sandboxes/${id}/ssh`, { publicKey: KEY })).body.wakeSecret
    h.billing.decision = { allow: false, reason: 'member_concurrency_limit', suspendRunning: false }
    expect((await wake(secret)).status).toBe(200)
    h.billing.decision = { allow: false, reason: 'not_a_member', suspendRunning: false }
    expect(await (await wake(secret)).json()).toEqual({ error: 'entitlement_denied', reason: 'not_a_member' })
  })

  it('refuses bad keys and wrong secrets, and forgets SSH on destroy', async () => {
    const { h, id, wake, asAlice } = await setup()
    expect((await asAlice('POST', `/v1/sandboxes/${id}/ssh`, { publicKey: 'ssh-ed25519 short' })).status).toBe(400)
    expect((await asAlice('POST', `/v1/sandboxes/${id}/ssh`, { publicKey: `${KEY}\ncommand="x"` })).status).toBe(400)
    const secret = (await asAlice('POST', `/v1/sandboxes/${id}/ssh`, { publicKey: KEY })).body.wakeSecret
    expect((await wake(`osw_${'x'.repeat(43)}`)).status).toBe(401)
    await asAlice('DELETE', `/v1/sandboxes/${id}`)
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM sandbox_ssh').get()).toEqual({ n: 0 })
    expect((await wake(secret)).status).toBe(401)
  })
})
