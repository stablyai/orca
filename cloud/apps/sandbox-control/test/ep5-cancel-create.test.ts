// EP-5: a desktop that cancels a create mid-request disconnects. The create used to die with the
// request (Workers cancel it), leaving the row `creating` and the Idempotency-Key pending, so every
// cancel replay answered 409 until the 5 min sweep. The create now outlives its request
// (ctx.waitUntil), so the replay gets the sandbox to delete; a delete that lands while the create
// is still running wins (the create frees its VM instead of finishing); and a create that was cut
// off anyway is swept (create-speed.test.ts covers the 5 min sweep).
import { describe, expect, it } from 'vitest'
import { HostedSandboxReadyResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { createHarness } from './harness'

const create = { workspaceId: 'ws-cancel', machineSize: 'standard' }
const key = { 'idempotency-key': 'press-0123456789' }

async function setup() {
  const background: Promise<unknown>[] = []
  const h = await createHarness({}, { waitUntil: (work) => void background.push(work) })
  // Hold the provider's VM create so the request is still mid-create when the client goes away.
  let open = (): void => {}
  const held = new Promise<void>((resolve) => (open = resolve))
  const createVm = h.vercel.createSandbox.bind(h.vercel)
  h.vercel.createSandbox = async (params) => {
    await held
    return createVm(params)
  }
  const row = () => h.raw.prepare(`SELECT id, status, provider_name FROM sandboxes WHERE workspace_id = ? ORDER BY rowid DESC`).get(create.workspaceId) as any
  const untilCreating = async () => {
    for (let i = 0; i < 200 && row()?.status !== 'creating'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(row()?.status).toBe('creating')
  }
  const liveVms = () => [...(h.vercel as any).boxes.values()].filter((box: any) => box.params.tags?.orcaSandbox === row()?.id)
  return { h, background, open, row, untilCreating, liveVms }
}

describe('EP-5: cancelling a create mid-request', () => {
  it('the create outlives its request, so the replay gets the sandbox instead of 409 in progress', async () => {
    const t = await setup()
    const first = t.h.call('POST', '/v1/sandboxes', { body: create, headers: key })
    await t.untilCreating()
    expect(t.background.length).toBeGreaterThan(0)
    // While it runs, a replay is told to wait (the desktop retries).
    expect((await t.h.call('POST', '/v1/sandboxes', { body: create, headers: key })).status).toBe(409)
    // The client is gone: only the work handed to waitUntil carries on, and it finishes.
    t.open()
    await Promise.all(t.background.splice(0))
    await first
    expect(t.row().status).toBe('running')
    const replay = await t.h.call('POST', '/v1/sandboxes', { body: create, headers: key })
    expect(replay.status).toBe(200)
    const id = HostedSandboxReadyResponseSchema.parse(replay.body).sandbox.id
    expect(id).toBe(t.row().id)
    // ... and the cancel deletes it for real.
    expect((await t.h.call('DELETE', `/v1/sandboxes/${id}`)).status).toBe(200)
    expect(t.row().status).toBe('destroyed')
    expect(t.liveVms()).toEqual([])
  })

  it('a delete while the VM is still being made wins: the create frees its VM instead of finishing', async () => {
    const t = await setup()
    const first = t.h.call('POST', '/v1/sandboxes', { body: create, headers: key })
    await t.untilCreating()
    const id = t.row().id
    const deleted = await t.h.call('DELETE', `/v1/sandboxes/${id}`)
    expect(deleted.status).toBe(200)
    // The VM arrives after the delete: the create sees the row is no longer its own and frees it.
    t.open()
    await Promise.all(t.background.splice(0))
    expect((await first).status).not.toBe(200)
    expect(t.row().status).toBe('destroyed')
    expect(t.liveVms()).toEqual([])
  })
})
