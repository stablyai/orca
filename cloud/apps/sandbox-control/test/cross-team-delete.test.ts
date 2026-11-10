import { describe, expect, it } from 'vitest'
import { HostedSandboxReadyResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { createHarness } from './harness'

const create = { workspaceId: 'ws-cross-team', machineSize: 'standard' }

describe('deleting a sandbox after a team switch', () => {
  it('lets the creator see and delete their sandbox while another team is active', async () => {
    const h = await createHarness()
    const { sandbox } = HostedSandboxReadyResponseSchema.parse(
      (await h.call('POST', '/v1/sandboxes', { body: create })).body
    )
    // Same user, different active team (W9 D-2: create on personal, switch to a team, Delete).
    const team = await h.token('alice', 'acme')
    expect((await h.call('GET', `/v1/sandboxes/${sandbox.id}`, { bearer: team })).status).toBe(200)
    const deleted = await h.call('DELETE', `/v1/sandboxes/${sandbox.id}`, { bearer: team })
    expect(deleted.status).toBe(200)
    expect(deleted.body).toMatchObject({ sandbox: { status: 'destroyed' } })
    expect(h.vercel.boxes.size).toBe(0)
  })

  it('a creator removed from the team cannot reach its sandbox from another account', async () => {
    const h = await createHarness({ OPERATOR_TOKEN: 'o'.repeat(40) })
    const acme = await h.token('alice', 'acme')
    const { sandbox } = HostedSandboxReadyResponseSchema.parse(
      (await h.call('POST', '/v1/sandboxes', { body: create, bearer: acme })).body
    )
    await h.call('POST', '/v1/internal/members/removed', {
      bearer: 'o'.repeat(40),
      body: { accountId: 'org:acme', userId: 'alice' }
    })
    expect((await h.call('DELETE', `/v1/sandboxes/${sandbox.id}`)).status).toBe(404)
    expect(h.vercel.boxes.size).toBe(1)
  })

  it('still hides the sandbox from other users, and the switched team cannot resume it', async () => {
    const h = await createHarness()
    const { sandbox } = HostedSandboxReadyResponseSchema.parse(
      (await h.call('POST', '/v1/sandboxes', { body: create })).body
    )
    expect((await h.call('DELETE', `/v1/sandboxes/${sandbox.id}`, { as: 'mallory' })).status).toBe(
      404
    )
    const team = await h.token('alice', 'acme')
    expect(
      (await h.call('POST', `/v1/sandboxes/${sandbox.id}/resume`, { bearer: team })).status
    ).toBe(404)
    expect(h.vercel.boxes.size).toBe(1)
  })
})
