import { describe, expect, it } from 'vitest'
import { HostedWakeResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { SSH_START_SCRIPT } from '../src/sandbox-ssh'
import { createHarness } from './harness'

const KEY = `ssh-ed25519 ${'A'.repeat(68)} me@laptop`

async function setup() {
  const h = await createHarness()
  const { body } = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' } })
  const id = body.sandbox.id as string
  const scripts: Record<string, string>[] = []
  h.vercel.onScript = (script) => {
    if (script !== SSH_START_SCRIPT) {
      return undefined
    }
    scripts.push(h.vercel.commands.at(-1)!.env)
    return { exitCode: 0, stdout: '{"ok":true,"user":"vercel-sandbox"}\n', stderr: '' }
  }
  const wake = (secret: string) =>
    h.send(
      new Request(`https://sandbox.test/v1/ssh-wake/${id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        body: '{"wait":true}'
      })
    )
  return { h, id, scripts, wake }
}

describe('wake on SSH', () => {
  it('sets up a scoped wake secret, wakes a sleeping VM, starts sshd + bridge and returns the bridge endpoint', async () => {
    const { h, id, scripts, wake } = await setup()
    const res = await h.call('POST', `/v1/sandboxes/${id}/ssh`, { body: { publicKey: KEY } })
    expect(res.status).toBe(200)
    expect(res.body.wakeUrl).toBe(`https://sandbox.test/v1/ssh-wake/${id}`)
    expect(res.body.user).toBe('vercel-sandbox')
    const secret = res.body.wakeSecret as string
    expect(JSON.stringify(h.raw.prepare('SELECT * FROM sandbox_ssh').get())).not.toContain(secret)
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    const answer = HostedWakeResponseSchema.parse(await (await wake(secret)).json())
    expect(answer.state).toBe('ready')
    expect(answer.endpoint).toMatch(/^wss:\/\/p2222-sb-\d+\.vercel\.run\/\?t=[A-Za-z0-9_%-]+$/)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]!.ORCA_SSH_PUBKEY).toBe(KEY)
    expect(answer.endpoint).toContain(encodeURIComponent(scripts[0]!.ORCA_SSH_BRIDGE_TOKEN!))
  })

  it('refuses a wrong or rotated secret, bad keys, other accounts, and forgets SSH on destroy', async () => {
    const { h, id, wake } = await setup()
    expect((await h.call('POST', `/v1/sandboxes/${id}/ssh`, { body: { publicKey: 'ssh-ed25519 short' } })).status).toBe(400)
    expect((await h.call('POST', `/v1/sandboxes/${id}/ssh`, { body: { publicKey: `${KEY}\ncommand="x"` } })).status).toBe(400)
    const first = (await h.call('POST', `/v1/sandboxes/${id}/ssh`, { body: { publicKey: KEY } })).body.wakeSecret
    const second = (await h.call('POST', `/v1/sandboxes/${id}/ssh`, { body: { publicKey: KEY } })).body.wakeSecret
    expect((await wake(first)).status).toBe(401)
    expect((await wake(`osw_${'x'.repeat(43)}`)).status).toBe(401)
    expect((await wake(second)).status).toBe(200)
    expect((await h.call('POST', `/v1/sandboxes/${id}/ssh`, { as: 'bob', body: { publicKey: KEY } })).status).toBe(404)
    await h.call('DELETE', `/v1/sandboxes/${id}`)
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM sandbox_ssh').get()).toEqual({ n: 0 })
    expect((await wake(second)).status).toBe(401)
  })
})
