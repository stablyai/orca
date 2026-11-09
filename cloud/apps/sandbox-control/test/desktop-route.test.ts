import { describe, expect, it } from 'vitest'
import { DESKTOP_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const create = { workspaceId: 'ws-desktop', machineSize: 'standard' }

async function running() {
  const h = await createHarness()
  const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
  return { h, id: body.sandbox.id as string }
}

describe('POST /v1/sandboxes/:id/desktop', () => {
  it("runs only the image's desktop entry point and returns its loopback port", async () => {
    const { h, id } = await running()
    const response = await h.call('POST', `/v1/sandboxes/${id}/desktop`)
    expect(response).toEqual({ status: 200, body: { desktop: { port: 6080, path: 'vnc.html', password: 'Ab3dE6gH' } } })
    const ran = h.vercel.commands.filter((c) => c.command === DESKTOP_COMMAND)
    expect(ran).toHaveLength(1)
    expect(ran[0]!.env).toEqual({})
  })

  it('says the image has no desktop (exit 3, or a pre-desktop image Vercel cannot spawn the command in)', async () => {
    for (const exitCode of [3, 127]) {
      const { h, id } = await running()
      h.vercel.desktop = { exitCode, stdout: '' }
      const response = await h.call('POST', `/v1/sandboxes/${id}/desktop`)
      expect(response).toEqual({ status: 409, body: { error: 'conflict', reason: 'desktop_not_installed' } })
    }
  })

  it('summarizes start failures and malformed ready lines without VM output', async () => {
    const { h, id } = await running()
    h.vercel.desktop = { exitCode: 1, stdout: 'secret-ish log line' }
    expect(await h.call('POST', `/v1/sandboxes/${id}/desktop`)).toEqual({
      status: 502,
      body: { error: 'provider_unavailable', reason: 'desktop_start_failed' }
    })
    h.vercel.desktop = { exitCode: 0, stdout: '{"schemaVersion":1,"port":6080,"display":":1","path":"vnc.html","password":"short"}' }
    expect(await h.call('POST', `/v1/sandboxes/${id}/desktop`)).toEqual({
      status: 502,
      body: { error: 'provider_unavailable', reason: 'desktop_ready_invalid' }
    })
  })

  it('refuses a suspended sandbox and hides other accounts\' sandboxes', async () => {
    const { h, id } = await running()
    expect((await h.call('POST', `/v1/sandboxes/${id}/desktop`, { as: 'mallory' })).status).toBe(404)
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    expect(await h.call('POST', `/v1/sandboxes/${id}/desktop`)).toEqual({
      status: 409,
      body: { error: 'conflict', reason: 'sandbox_suspended' }
    })
    expect(h.vercel.commands.some((c) => c.command === DESKTOP_COMMAND)).toBe(false)
  })
})
