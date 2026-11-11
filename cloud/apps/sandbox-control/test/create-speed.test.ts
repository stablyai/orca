// Repo-backed creates: blobless background clone with progress, bounded failures that say why.
import { describe, expect, it } from 'vitest'
import { CLONE_STATUS_SCRIPT, parseCloneStatus } from '../src/clone-status'
import { maintainPool, poolConfigFromEnv } from '../src/pool'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { WORKSPACE_PRELUDE_SCRIPT } from '../image/vm-scripts.generated'
import { GOLDEN, createHarness } from './harness'

const MIN = 60_000
const repo = { url: 'https://github.com/acme/big.git' }
const create = { workspaceId: 'ws-1', machineSize: 'standard', repo }
const CLONE_FEATURE = { 'x-orca-sandbox-features': 'clone-progress' }

function startEnv(h: Awaited<ReturnType<typeof createHarness>>) {
  return h.vercel.commands.find((c) => c.command === START_COMMAND)!.env
}

describe('parseCloneStatus', () => {
  it('maps git stages onto one percent', () => {
    const at = (runs: string) => parseCloneStatus(`running\n${runs}`)
    expect(parseCloneStatus('none\n')).toEqual({ state: 'none' })
    expect(at('')).toEqual({ state: 'running', percent: 0, stage: 'download' })
    expect(at('Counting objects\t50\n')).toEqual({ state: 'running', percent: 5, stage: 'download' })
    expect(at('Counting objects\t100\nReceiving objects\t50\n')).toEqual({ state: 'running', percent: 30, stage: 'download' })
    expect(at('Receiving objects\t100\nResolving deltas\t50\n')).toEqual({ state: 'running', percent: 55, stage: 'download' })
    // The blobless checkout's own fetch of file contents prints nothing: held, never invented.
    expect(at('Receiving objects\t100\nResolving deltas\t100\n')).toEqual({ state: 'running', percent: 60, stage: 'checkout' })
    expect(at('Receiving objects\t100\nResolving deltas\t100\nReceiving objects\t40\n')).toEqual({
      state: 'running',
      percent: 72,
      stage: 'checkout'
    })
    expect(at('Receiving objects\t100\nResolving deltas\t100\nUpdating files\t50\n')).toEqual({
      state: 'running',
      percent: 95,
      stage: 'checkout'
    })
    expect(parseCloneStatus('done\nUpdating files\t100\n')).toEqual({ state: 'done' })
  })

  it('reports only known failure reasons', () => {
    expect(parseCloneStatus('failed clone_timeout\n')).toEqual({ state: 'failed', reason: 'clone_timeout' })
    expect(parseCloneStatus('failed repo_unreachable\n')).toEqual({ state: 'failed', reason: 'repo_unreachable' })
    expect(parseCloneStatus('failed something https://x\n')).toEqual({ state: 'failed', reason: 'clone_failed' })
  })
})

describe('repo-backed create', () => {
  it('clones blobless, and only in the background for a desktop that shows the clone step', async () => {
    expect(WORKSPACE_PRELUDE_SCRIPT).toContain('--filter=blob:none')
    const h = await createHarness()
    const old = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(old.status).toBe(200)
    expect(old.body.clone).toBeUndefined()
    expect(startEnv(h).ORCA_CLONE_BACKGROUND).toBeUndefined()

    h.vercel.commands.length = 0
    const res = await h.call('POST', '/v1/sandboxes', { body: { ...create, workspaceId: 'ws-2' }, headers: CLONE_FEATURE })
    expect(res.status).toBe(200)
    expect(res.body.clone).toEqual({ state: 'running' })
    expect(startEnv(h).ORCA_CLONE_BACKGROUND).toBe('1')
  })

  it('no repo, no background clone', async () => {
    const h = await createHarness()
    const res = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, headers: CLONE_FEATURE })
    expect(res.body.clone).toBeUndefined()
  })

  it('GET /clone reports progress, and a failed clone sets last_error', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create, headers: CLONE_FEATURE })
    let vm = 'running\nReceiving objects\t100\nResolving deltas\t20\n'
    h.vercel.commandHandler = (params) =>
      params.command === 'bash' && params.args?.[1] === CLONE_STATUS_SCRIPT ? { exitCode: 0, stdout: vm, stderr: '' } : undefined
    const running = await h.call('GET', `/v1/sandboxes/${body.sandbox.id}/clone`)
    expect(running.body).toEqual({ clone: { state: 'running', percent: 52, stage: 'download' } })

    vm = 'failed repo_unreachable\n'
    const failed = await h.call('GET', `/v1/sandboxes/${body.sandbox.id}/clone`)
    expect(failed.body).toEqual({ clone: { state: 'failed', reason: 'repo_unreachable' } })
    const row = h.raw.prepare('SELECT last_error FROM sandboxes WHERE id = ?').get(body.sandbox.id) as { last_error: string }
    expect(row.last_error).toBe('repo_unreachable')

    // Someone else's sandbox is not found.
    expect((await h.call('GET', `/v1/sandboxes/${body.sandbox.id}/clone`, { as: 'mallory' })).status).toBe(404)
  })

  it('a failed start records why instead of a bare create_failed', async () => {
    const h = await createHarness()
    h.vercel.failStart = true
    const res = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(res.status).toBeGreaterThanOrEqual(500)
    const row = h.raw.prepare('SELECT status, last_error FROM sandboxes').get() as { status: string; last_error: string }
    expect(row.last_error).toBe('orcad_start_failed')
  })

  it('a pooled boot that ran long is not retried on a fresh VM (that would double the wait)', async () => {
    const h = await createHarness({ SANDBOX_POOL_SIZE: '1' })
    await maintainPool({
      db: h.env.SANDBOX_DB,
      provider: h.vercel,
      now: h.now,
      config: { environment: 'test', goldenSnapshotId: GOLDEN, defaultRegion: 'iad1', pool: poolConfigFromEnv(h.env) }
    })
    let starts = 0
    h.vercel.commandHandler = (params) => {
      if (params.args?.[1]?.endsWith(`exec ${START_COMMAND}`) || params.command === START_COMMAND) {
        starts++
        h.advance(2 * MIN) // the start command's 120 s timeout
        return { exitCode: 1, stdout: '', stderr: 'timed out' }
      }
      return undefined
    }
    const res = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(starts).toBe(1)
  })

  it('the start gate counts neither a sandbox going to sleep nor an abandoned create', async () => {
    const h = await createHarness()
    const ids: string[] = []
    // Billing's cap is 3 here (the guardrail backstop: 3 per seat, 1 seat).
    for (const ws of ['ws-a', 'ws-b', 'ws-c']) {
      ids.push(String((await h.call('POST', '/v1/sandboxes', { body: { workspaceId: ws, machineSize: 'standard' } })).body.sandbox.id))
    }
    // One is draining toward sleep; one is a create whose Worker was cut off 6 minutes ago.
    h.raw.prepare(`UPDATE sandboxes SET status = 'suspending' WHERE id = ?`).run(ids[0]!)
    h.raw.prepare(`UPDATE sandboxes SET status = 'creating', updated_at = ? WHERE id = ?`).run(h.now() - 6 * MIN, ids[1]!)
    h.billing.requests.length = 0
    expect((await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-d', machineSize: 'standard' } })).status).toBe(200)
    expect(h.billing.requests[0]).toMatchObject({ runningSandboxes: 1, runningSandboxesForUser: 1 })
    // A create still in flight (recent) does count.
    h.raw.prepare(`UPDATE sandboxes SET updated_at = ? WHERE id = ?`).run(h.now() - MIN, ids[1]!)
    h.billing.requests.length = 0
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-e', machineSize: 'standard' } })
    expect(h.billing.requests[0]).toMatchObject({ runningSandboxes: 3, runningSandboxesForUser: 3 })
  })

  it('an Idempotency-Key makes one sandbox per intent, for that account and member only (PC-8)', async () => {
    const h = await createHarness()
    const key = { 'idempotency-key': 'create-press-0001' }
    const first = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w-a', machineSize: 'standard' }, headers: key })
    expect(first.status).toBe(200)
    // A re-fired start of the same press (same key, same body): the same sandbox, nothing new.
    const again = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w-a', machineSize: 'standard' }, headers: key })
    expect(again.status).toBe(200)
    expect(again.body.sandbox.id).toBe(first.body.sandbox.id)
    expect(h.vercel.boxes.size).toBe(1)
    // Same key, different request: refused, not silently merged.
    const other = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w-b', machineSize: 'standard' }, headers: key })
    expect(other.status).toBe(422)
    // Keys are per member: someone else's press with the same key is their own create.
    const bob = await h.call('POST', '/v1/sandboxes', { as: 'bob', body: { workspaceId: 'w-a', machineSize: 'standard' }, headers: key })
    expect(bob.status).toBe(200)
    expect(bob.body.sandbox.id).not.toBe(first.body.sandbox.id)
    // A bad key is a 400, before anything starts.
    const bad = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w-c', machineSize: 'standard' }, headers: { 'idempotency-key': 'x' } })
    expect(bad.status).toBe(400)
  })

  it('a create whose Worker was cut off is failed after 5 minutes, not 15', async () => {
    const h = await createHarness()
    const { body } = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' } })
    h.raw.prepare(`UPDATE sandboxes SET status = 'creating' WHERE id = ?`).run(body.sandbox.id)
    h.advance(4 * MIN)
    expect((await h.reconcile()).released).toBe(0)
    h.advance(2 * MIN)
    expect((await h.reconcile()).released).toBe(1)
    const row = h.raw.prepare('SELECT status, last_error FROM sandboxes WHERE id = ?').get(body.sandbox.id) as {
      status: string
      last_error: string
    }
    expect(row).toEqual({ status: 'destroyed', last_error: 'create_abandoned' })
    expect(h.vercel.boxes.size).toBe(0)
  })
})

describe('VM hostname (JA-27)', () => {
  it('is the workspace name (else the repo), as a hostname label, set at every start', async () => {
    const { workspaceHostname } = await import('../src/sandbox-vm-commands')
    expect(workspaceHostname('Fix Login Bug!')).toBe('fix-login-bug')
    expect(workspaceHostname('--ja_hello--')).toBe('ja-hello')
    expect(workspaceHostname('🙂')).toBeUndefined()
    expect(workspaceHostname('a'.repeat(80))).toHaveLength(63)
    const h = await createHarness()
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w1', machineSize: 'standard', title: 'Ja Hello', repo } })
    const start = h.vercel.commands.find((c) => c.command === START_COMMAND)!
    expect(start.env.ORCA_HOSTNAME).toBe('ja-hello')
    expect(start.args?.[1]).toContain('sudo -n hostname "$ORCA_HOSTNAME"')
  })
})
