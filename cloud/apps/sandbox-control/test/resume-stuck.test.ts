// RESUME-STUCK: a resume whose client quits mid-wake used to leave the row `resuming`, and every
// later resume answered 409 until the 15 min cron or a Restart. The wake now outlives the request
// (ctx.waitUntil), a resume joins a wake already in flight, and a stale one is adopted.
import { describe, expect, it } from 'vitest'
import { HostedSandboxReadyResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { RESUME_STALE_MS } from '../src/lifecycle'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

const create = { workspaceId: 'ws-1', machineSize: 'standard' }

async function setup() {
  const background: Promise<unknown>[] = []
  const onSleep: ((ms: number) => void)[] = []
  let sleeps = 0
  const h = await createHarness(
    {},
    {
      waitUntil: (work) => void background.push(work),
      sleep: async (ms) => {
        sleeps++
        h.advance(ms)
        onSleep.forEach((fn) => fn(ms))
      }
    }
  )
  const created = HostedSandboxReadyResponseSchema.parse((await h.call('POST', '/v1/sandboxes', { body: create })).body)
  const id = created.sandbox.id
  const name = `orca-test-${id}`
  // Provider resumes (getSandbox with resume: true) the lifecycle asked for.
  const resumes: string[] = []
  const getSandbox = h.vercel.getSandbox.bind(h.vercel)
  h.vercel.getSandbox = async (n, options) => {
    if (options.resume) {
      resumes.push(n)
    }
    return getSandbox(n, options)
  }
  const row = () => h.raw.prepare('SELECT status, orcad_endpoint FROM sandboxes WHERE id = ?').get(id) as any
  const setResuming = () => h.raw.prepare(`UPDATE sandboxes SET status = 'resuming', updated_at = ? WHERE id = ?`).run(h.now(), id)
  const starts = () => h.vercel.commands.filter((c) => c.command === START_COMMAND).length
  return { h, id, name, background, onSleep, sleeps: () => sleeps, resumes, row, setResuming, starts, getSandbox }
}

describe('resume whose client quits mid-wake', () => {
  it('registers the wake with waitUntil, and it reaches running without the request', async () => {
    const t = await setup()
    await t.h.call('POST', `/v1/sandboxes/${t.id}/suspend`)
    // Hold the provider resume so the request is still mid-wake when the client goes away.
    let open = (): void => {}
    const held = new Promise<void>((resolve) => (open = resolve))
    t.h.vercel.getSandbox = async (n, options) => {
      if (options.resume) {
        await held
      }
      return t.getSandbox(n, options)
    }
    t.background.length = 0
    const request = t.h.call('POST', `/v1/sandboxes/${t.id}/resume`)
    // Wait (bounded) for the claim; a fixed sleep raced under full-suite load.
    for (let i = 0; i < 200 && t.row().status !== 'resuming'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(t.row().status).toBe('resuming')
    expect(t.background.length).toBeGreaterThan(0)
    // The client is gone: only the work handed to waitUntil carries on.
    open()
    await Promise.all(t.background.splice(0))
    expect(t.row()).toMatchObject({ status: 'running', orcad_endpoint: expect.stringMatching(/^wss:/) })
    expect((await request).status).toBe(200)
  })
})

describe('resume of a row left resuming', () => {
  it('a stale row whose session stopped resumes (not 409)', async () => {
    const t = await setup()
    await t.h.call('POST', `/v1/sandboxes/${t.id}/suspend`)
    t.setResuming()
    t.h.advance(RESUME_STALE_MS + 1000)
    const res = await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`)
    expect(res.status).toBe(200)
    expect(res.body.sandbox.status).toBe('running')
    expect(t.resumes).toEqual([t.name])
    expect(t.row().status).toBe('running')
    // Stale already: no waiting on a wake that is gone.
    expect(t.sleeps()).toBe(0)
  })

  it('a stale row whose session is running is adopted and booted, with no new provider resume', async () => {
    const t = await setup()
    await t.h.call('POST', `/v1/sandboxes/${t.id}/suspend`)
    // The cut-off wake got the VM up, then lost its Worker before orcad.
    await t.getSandbox(t.name, { resume: true })
    t.setResuming()
    t.h.advance(RESUME_STALE_MS + 1000)
    const before = t.starts()
    const res = await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`)
    expect(res.status).toBe(200)
    expect(res.body.sandbox.status).toBe('running')
    expect(t.resumes).toEqual([])
    expect(t.starts()).toBe(before + 1)
    expect(t.row()).toMatchObject({ status: 'running', orcad_endpoint: expect.stringMatching(/^wss:/) })
  })

  it('a fresh row that finishes while a second resume waits answers ready', async () => {
    const t = await setup()
    t.setResuming()
    // Someone else's wake finishes after a few polls.
    t.onSleep.push(() => {
      if (t.sleeps() === 3) {
        t.h.raw.prepare(`UPDATE sandboxes SET status = 'running', updated_at = ? WHERE id = ?`).run(t.h.now(), t.id)
      }
    })
    const before = t.starts()
    const res = await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`)
    expect(res.status).toBe(200)
    expect(res.body.sandbox.status).toBe('running')
    expect(t.sleeps()).toBe(3)
    expect(t.resumes).toEqual([])
    expect(t.starts()).toBe(before)
  })

  it('a fresh row that stays resuming past the join window answers 409 without booting', async () => {
    const t = await setup()
    await t.h.call('POST', `/v1/sandboxes/${t.id}/suspend`)
    t.setResuming()
    const before = t.starts()
    const res = await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`)
    expect(res).toMatchObject({ status: 409, body: { reason: 'sandbox_resuming' } })
    expect(t.sleeps()).toBeGreaterThan(0)
    expect(t.resumes).toEqual([])
    expect(t.starts()).toBe(before)
    expect(t.row().status).toBe('resuming')
  })
})
