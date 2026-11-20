import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claimLocalTask,
  createLocalTask,
  releaseLocalTask,
  renewLocalTask,
  updateLocalTask
} from './local-task-writes'

let dir: string
const file = (id: string): string => join(dir, `${id}.md`)
const write = (id: string, text: string): void => writeFileSync(file(id), text)
const read = (id: string): string => readFileSync(file(id), 'utf8')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-local-writes-'))
  process.env.ORCA_LOCAL_TASKS_DIR = dir
})
afterEach(() => {
  delete process.env.ORCA_LOCAL_TASKS_DIR
  rmSync(dir, { recursive: true, force: true })
})

const UNKNOWN =
  '---\ntitle: Keep me\n# a comment\nstage: build # trailing\nstatus: queued\nweird: x: y\n---\nBody\n\n- line\n'

describe('local task writes', () => {
  it('create writes a task and refuses to overwrite', async () => {
    const task = await createLocalTask({
      title: 'Hello World',
      priority: 2,
      labels: ['a', 'b'],
      body: 'desc'
    })
    expect(task).toMatchObject({
      id: 'hello-world',
      status: 'todo',
      priority: 2,
      labels: ['a', 'b']
    })
    expect(read('hello-world')).toMatch(
      /^---\ntitle: Hello World\nstatus: todo\n[\s\S]*---\ndesc\n$/
    )
    await expect(createLocalTask({ title: 'x', id: 'hello-world' })).rejects.toThrow(
      /already exists/
    )
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('update changes only targeted lines and preserves the rest byte-for-byte', async () => {
    write('t1', UNKNOWN)
    await updateLocalTask('t1', { status: 'working', priority: 1 })
    // `updated` is bumped to today's date; assert the rest byte-for-byte without reading the clock.
    expect(read('t1').replace(/^updated: \d{4}-\d{2}-\d{2}$/m, 'updated: DATE')).toBe(
      UNKNOWN.replace('status: queued', 'status: working').replace(
        'weird: x: y\n',
        'weird: x: y\npriority: 1\nupdated: DATE\n'
      )
    )
  })

  it('preserves CRLF files', async () => {
    write('crlf', '---\r\ntitle: A\r\nstatus: queued\r\n---\r\nbody\r\n')
    await updateLocalTask('crlf', { status: 'done' })
    expect(read('crlf')).toMatch(
      /^---\r\ntitle: A\r\nstatus: done\r\nupdated: [\d-]+\r\n---\r\nbody\r\n$/
    )
  })

  it('rejects bad ids, statuses, priorities, deps and injection', async () => {
    write('ok', UNKNOWN)
    for (const id of ['../x', 'a/b', '.hidden', 'A', '', 'a\\b']) {
      await expect(createLocalTask({ title: 't', id })).rejects.toThrow(/Invalid task id/)
      await expect(updateLocalTask(id, { title: 't' })).rejects.toThrow(/Invalid task id/)
    }
    await expect(updateLocalTask('ok', { status: 'bogus' })).rejects.toThrow(/Unknown status/)
    await expect(updateLocalTask('ok', { priority: 6 })).rejects.toThrow(/priority/)
    await expect(updateLocalTask('ok', { priority: 1.5 })).rejects.toThrow(/priority/)
    await expect(updateLocalTask('ok', { dependsOn: ['../z'] })).rejects.toThrow(/Invalid task id/)
    await expect(updateLocalTask('ok', { title: 'a\nstatus: done' })).rejects.toThrow(/single line/)
    await expect(updateLocalTask('ok', { url: 'x\r\ny: z' })).rejects.toThrow(/single line/)
    expect(read('ok')).toBe(UNKNOWN)
  })

  it('concurrent claim lets exactly one claimer win', async () => {
    write('c1', '---\ntitle: C\nstatus: queued\n---\n')
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => claimLocalTask('c1', `agent-${i}`))
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(read('c1')).toMatch(/status: working/)
    expect(readdirSync(dir).filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('refuses claim while dependencies are unmet, allows once done', async () => {
    write('dep', '---\ntitle: D\nstatus: queued\n---\n')
    write('child', '---\ntitle: K\nstatus: queued\ndepends_on: [dep]\n---\n')
    await expect(claimLocalTask('child', 'a')).rejects.toThrow(/waiting/)
    await updateLocalTask('dep', { status: 'done' })
    await expect(claimLocalTask('child', 'a')).resolves.toMatchObject({
      claimedBy: 'a',
      status: 'working'
    })
  })

  it('takes over an expired lease but not a live one', async () => {
    // Fixed instants far from any real clock: long expired vs. never expiring.
    const old = '2000-01-01T00:00:00.000Z'
    write('stale', `---\ntitle: S\nstatus: queued\nclaimed_by: dead\nclaimed_at: ${old}\n---\n`)
    write(
      'live',
      `---\ntitle: L\nstatus: queued\nclaimed_by: alive\nclaimed_at: 2999-01-01T00:00:00.000Z\n---\n`
    )
    await expect(claimLocalTask('live', 'b')).rejects.toThrow(/claimed/)
    await expect(claimLocalTask('stale', 'b')).resolves.toMatchObject({ claimedBy: 'b' })
  })

  it('clears a stale blocked_reason when the task leaves blocked', async () => {
    write('bl', '---\ntitle: B\nstatus: blocked\nblocked_reason: waiting on infra\n---\n')
    await expect(updateLocalTask('bl', { status: 'blocked' })).resolves.toMatchObject({
      blockedReason: 'waiting on infra'
    })
    await expect(updateLocalTask('bl', { status: 'queued' })).resolves.toMatchObject({
      status: 'queued',
      blockedReason: null
    })
  })

  it('release only works for the owner', async () => {
    write('r1', '---\ntitle: R\nstatus: queued\n---\n')
    await claimLocalTask('r1', 'owner')
    await expect(releaseLocalTask('r1', 'other')).rejects.toThrow(/not claimed by/)
    const released = await releaseLocalTask('r1', 'owner')
    expect(released).toMatchObject({ status: 'queued', claimedBy: null, claimedAt: null })
  })

  it('renew bumps claimed_at for the holder, even after the lease lapsed', async () => {
    const old = '2020-01-01T00:00:00.000Z'
    write('n1', `---\ntitle: N\nstatus: working\nclaimed_by: me\nclaimed_at: ${old}\n---\n`)
    const task = await renewLocalTask('n1', 'me')
    expect(Date.parse(task.claimedAt ?? '')).toBeGreaterThan(Date.parse(old))
    expect(task).toMatchObject({ claimedBy: 'me', status: 'working' })
  })

  it('renew is rejected for non-holders, after takeover, unclaimed and non-working tasks', async () => {
    const old = '2020-01-01T00:00:00.000Z'
    write('n2', `---\ntitle: N\nstatus: working\nclaimed_by: me\nclaimed_at: ${old}\n---\n`)
    await expect(renewLocalTask('n2', 'other')).rejects.toThrow(/claimed by me/)
    write('n3', `---\ntitle: N\nstatus: queued\nclaimed_by: dead\nclaimed_at: ${old}\n---\n`)
    await claimLocalTask('n3', 'taker')
    await expect(renewLocalTask('n3', 'dead')).rejects.toThrow(/claimed by taker/)
    write('n4', '---\ntitle: N\nstatus: queued\n---\n')
    await expect(renewLocalTask('n4', 'me')).rejects.toThrow(/not claimed/)
    write('n5', '---\ntitle: N\nstatus: blocked\nclaimed_by: me\n---\n')
    await expect(renewLocalTask('n5', 'me')).rejects.toThrow(/not working/)
  })
})
