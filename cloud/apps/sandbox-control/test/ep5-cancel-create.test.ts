// EP-5: a desktop that cancels a create mid-request disconnects. The create used to die with the
// request (Workers cancel it), leaving the row `creating` and the Idempotency-Key pending, so every
// cancel replay answered 409 until the 5 min sweep. The create now outlives its request
// (ctx.waitUntil), so the replay gets the sandbox to delete; a delete that lands while the create
// is still running wins (the create frees its VM instead of finishing); and a create that was cut
// off anyway is swept (create-speed.test.ts covers the 5 min sweep).
import { describe, expect, it } from 'vitest'
import { HostedSandboxReadyResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { maintainPool, poolConfigFromEnv } from '../src/pool'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { GOLDEN, createHarness } from './harness'

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

  // EP-5 on n48: the desktop deleted the pooled row mid-create; the create (now outliving its request)
  // took the failed adopt/boot for a bad pooled VM and retried with a fresh row that ran to the end.
  it('a delete during a pooled create wins: no retry with a new row, nothing left running', async () => {
    const background: Promise<unknown>[] = []
    const h = await createHarness({ SANDBOX_POOL_SIZE: '1' }, { waitUntil: (work) => void background.push(work) })
    await maintainPool({
      db: h.env.SANDBOX_DB,
      provider: h.vercel,
      now: h.now,
      config: { environment: 'test', goldenSnapshotId: GOLDEN, defaultRegion: 'iad1', pool: poolConfigFromEnv(h.env) }
    })
    // Hold orcad's start on the adopted VM so the cancel lands mid-boot.
    let open = (): void => {}
    const held = new Promise<void>((resolve) => (open = resolve))
    const run = h.vercel.runCommand.bind(h.vercel)
    h.vercel.runCommand = async (sessionId, params) => {
      if (params.command === START_COMMAND) {
        await held
      }
      return run(sessionId, params)
    }
    const rows = () => h.raw.prepare(`SELECT id, status FROM sandboxes WHERE workspace_id = ? ORDER BY rowid`).all(create.workspaceId) as { id: string; status: string }[]
    const first = h.call('POST', '/v1/sandboxes', { body: create, headers: key })
    for (let i = 0; i < 200 && rows()[0]?.status !== 'creating'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const pooledId = rows()[0]!.id
    expect((await h.call('DELETE', `/v1/sandboxes/${pooledId}`)).status).toBe(200)
    open()
    await Promise.all(background.splice(0))
    expect((await first).status).not.toBe(200)
    // One row, the deleted one: no fresh create took the workspace after the cancel.
    expect(rows()).toEqual([{ id: pooledId, status: 'destroyed' }])
    const workspaceIds = new Set(rows().map((r) => r.id))
    const live = [...(h.vercel as any).boxes.values()].filter((box: any) => workspaceIds.has(box.params.tags?.orcaSandbox) || box.params.name.endsWith(pooledId))
    expect(live).toEqual([])
    // ... and a replay of the cancelled create's key doesn't make one either.
    const replay = await h.call('POST', '/v1/sandboxes', { body: create, headers: key })
    expect(replay.status).toBe(409)
    expect(replay.body).toEqual({ error: 'conflict', reason: 'create_cancelled' })
    expect(rows()).toHaveLength(1)
  })
})

