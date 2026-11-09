import { describe, expect, it } from 'vitest'
import { HostedSandboxSshAccessResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { SSH_KEYS_COMMAND } from '../src/ssh-access'
import { createHarness } from './harness'

const create = { workspaceId: 'ws-1', machineSize: 'standard' }
const KEY = `ssh-ed25519 ${'A'.repeat(68)} orca:mac-studio:ws-1`

async function running() {
  const h = await createHarness()
  const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
  return { h, id: body.sandbox.id as string }
}

describe('ssh key routes', () => {
  it('installs a key through the fixed entry point and answers the pinned host key', async () => {
    const { h, id } = await running()
    const res = await h.call('POST', `/v1/sandboxes/${id}/ssh-keys`, { body: { publicKey: KEY } })
    expect(res.status).toBe(200)
    const { ssh } = HostedSandboxSshAccessResponseSchema.parse(res.body)
    expect(ssh).toMatchObject({ port: 2222, user: 'vercel-sandbox' })
    const command = h.vercel.commands.at(-1)!
    // The key travels in the env, never on the command line.
    expect(command).toMatchObject({ command: SSH_KEYS_COMMAND, args: ['add'], env: { ORCA_SSH_PUBLIC_KEY: KEY } })
    expect([...h.vercel.authorizedKeys.values()]).toEqual([[KEY]])
    expect(h.raw.prepare('SELECT action, target_id, detail FROM audit_log').all()).toEqual([
      { action: 'sandbox.ssh_key_added', target_id: id, detail: JSON.stringify({ key: 'orca:mac-studio:ws-1' }) }
    ])
  })

  it('revokes the key it installed', async () => {
    const { h, id } = await running()
    await h.call('POST', `/v1/sandboxes/${id}/ssh-keys`, { body: { publicKey: KEY } })
    const res = await h.call('DELETE', `/v1/sandboxes/${id}/ssh-keys`, { body: { publicKey: KEY } })
    expect(res.status).toBe(200)
    expect(h.vercel.commands.at(-1)!.args).toEqual(['remove'])
    expect([...h.vercel.authorizedKeys.values()]).toEqual([[]])
  })

  it.each([
    ['an rsa key', `ssh-rsa ${'A'.repeat(68)} orca:x`],
    ['key options', `command="sh" ssh-ed25519 ${'A'.repeat(68)} orca:x`],
    ['a second line', `ssh-ed25519 ${'A'.repeat(68)} orca:x\nssh-ed25519 ${'B'.repeat(68)} evil`],
    ['a comment with spaces', `ssh-ed25519 ${'A'.repeat(68)} orca x`]
  ])('refuses %s before reaching the VM', async (_label, publicKey) => {
    const { h, id } = await running()
    const before = h.vercel.commands.length
    const res = await h.call('POST', `/v1/sandboxes/${id}/ssh-keys`, { body: { publicKey } })
    expect(res).toEqual({ status: 400, body: { error: 'invalid_request' } })
    expect(h.vercel.commands).toHaveLength(before)
  })

  it('answers conflict for a sleeping workspace instead of waking it', async () => {
    const { h, id } = await running()
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    const res = await h.call('POST', `/v1/sandboxes/${id}/ssh-keys`, { body: { publicKey: KEY } })
    expect(res).toEqual({ status: 409, body: { error: 'conflict', reason: 'sandbox_suspended' } })
  })

  it('names an image without sshd so the desktop can say so', async () => {
    const { h, id } = await running()
    h.vercel.sshKeysExit = 3
    const res = await h.call('POST', `/v1/sandboxes/${id}/ssh-keys`, { body: { publicKey: KEY } })
    expect(res).toEqual({ status: 409, body: { error: 'conflict', reason: 'ssh_unsupported_image' } })
  })

  it('summarizes a failing entry point without its output', async () => {
    const { h, id } = await running()
    h.vercel.sshKeysExit = 1
    const res = await h.call('POST', `/v1/sandboxes/${id}/ssh-keys`, { body: { publicKey: KEY } })
    expect(res).toEqual({ status: 502, body: { error: 'provider_unavailable', reason: 'ssh_keys_failed' } })
  })

  it('hides another account’s sandbox', async () => {
    const { h, id } = await running()
    const res = await h.call('POST', `/v1/sandboxes/${id}/ssh-keys`, { body: { publicKey: KEY }, as: 'bob' })
    expect(res.status).toBe(404)
  })
})
