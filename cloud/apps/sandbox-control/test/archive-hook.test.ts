import { spawnSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostedArchiveHookResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-archive-hook-wire'
import { ARCHIVE_HOOK_SCRIPTS_FOR_TESTS } from '../src/archive-hook'
import type { RunCommandParams } from '../src/sandbox-provider'
import { createHarness } from './harness'

const YAML_PATH = '/vercel/sandbox/project/orca.yaml'
const HOOK_YAML = 'scripts:\n  archive: |\n    curl -fsS -X DELETE "$PREVIEW_DB_URL"\n'
const b64 = (text: string) => Buffer.from(text).toString('base64')

async function running(yaml: string | null = HOOK_YAML) {
  const h = await createHarness()
  const { body } = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' } })
  const box = h.vercel.boxes.get(`orca-test-${body.sandbox.id}`)!
  if (yaml !== null) {
    box.files.set(YAML_PATH, yaml)
  }
  const hookCalls: RunCommandParams[] = []
  let answer = `ORCA_ARCHIVE_HOOK ${b64('/vercel/sandbox/project')} 0 ${b64('deleted preview branch\n')}\n`
  h.vercel.commandHandler = (params) => {
    if (params.args?.[2] !== 'orca-archive-hook') {
      return undefined
    }
    hookCalls.push(params)
    return { exitCode: 0, stdout: answer, stderr: '' }
  }
  const id = body.sandbox.id as string
  const hook = async (request: Record<string, unknown> = {}) => {
    const res = await h.call('POST', `/v1/sandboxes/${id}/archive-hook`, { body: request })
    expect(res.status).toBe(200)
    return HostedArchiveHookResponseSchema.parse(res.body).archiveHook
  }
  return { h, id, hook, hookCalls, answer: (next: string) => (answer = next) }
}

describe('archive hook route', () => {
  it('runs the orca.yaml archive script on the running VM and reports each checkout', async () => {
    const { hook, hookCalls } = await running()
    expect(await hook()).toEqual({
      state: 'succeeded',
      runs: [{ path: '/vercel/sandbox/project', exitCode: 0, timedOut: false, output: 'deleted preview branch\n' }]
    })
    // The script is data (the runner's argument), run with `set -e` like the desktop's setup runner.
    expect(hookCalls[0]!.args![3]).toBe('#!/usr/bin/env bash\nset -e\ncurl -fsS -X DELETE "$PREVIEW_DB_URL"\n')
    expect(hookCalls[0]!.args![1]).not.toContain('PREVIEW_DB_URL')
    expect(hookCalls[0]!.args![4]).toBe('120')
  })

  it('reports a failing or timed-out checkout as failed, with its output', async () => {
    const { hook, answer } = await running()
    answer(
      `ORCA_ARCHIVE_HOOK ${b64('/w/a')} 3 ${b64('neon: 401\n')}\nORCA_ARCHIVE_HOOK ${b64('/w/b')} 124 ${b64('waiting…')}\n`
    )
    expect(await hook()).toEqual({
      state: 'failed',
      runs: [
        { path: '/w/a', exitCode: 3, timedOut: false, output: 'neon: 401\n' },
        { path: '/w/b', exitCode: null, timedOut: true, output: 'waiting…' }
      ]
    })
    answer('ORCA_ARCHIVE_HOOK_NO_ORCAD\n')
    expect(await hook()).toEqual({ state: 'failed', runs: [], reason: 'no_server' })
  })

  it('runs nothing when orca.yaml has no archive script', async () => {
    const { hook, hookCalls } = await running('scripts:\n  setup: pnpm i\n')
    expect(await hook()).toEqual({ state: 'not_configured' })
    expect(hookCalls).toHaveLength(0)
  })

  it('asleep: learned at Sleep, it asks before waking; with wake it wakes, runs, and is not run twice', async () => {
    const { h, id, hook, hookCalls } = await running()
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    expect((await h.call('GET', `/v1/sandboxes/${id}/archive-hook`)).body).toEqual({ archiveHook: { memo: 'pending', running: false, archived: false } })
    expect(await hook()).toEqual({ state: 'asleep', memo: 'pending' })
    expect(hookCalls).toHaveLength(0)

    const woken = await hook({ wake: true })
    expect(woken.state).toBe('succeeded')
    expect(hookCalls).toHaveLength(1)
    // The desktop's Sleep that follows keeps "done": an asleep delete after it doesn't wake it again.
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    expect(await hook({ wake: true })).toEqual({ state: 'already_ran' })
    expect(hookCalls).toHaveLength(1)

    // Any later wake may bring back what the hook tore down: the next archive runs it again.
    await h.call('POST', `/v1/sandboxes/${id}/resume`)
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    expect(await hook()).toEqual({ state: 'asleep', memo: 'pending' })
  })

  it('a run that fails after one that succeeded makes the hook pending again', async () => {
    const { h, id, hook, answer } = await running()
    expect((await hook()).state).toBe('succeeded')
    answer(`ORCA_ARCHIVE_HOOK ${b64('/vercel/sandbox/project')} 7 ${b64('')}\n`)
    expect((await hook()).state).toBe('failed')
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    expect(await hook()).toEqual({ state: 'asleep', memo: 'pending' })
  })

  it('never wakes a workspace whose repo has no hook, and refuses an archived one', async () => {
    const { h, id, hook } = await running('defaultTabs:\n  - title: x\n')
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    expect(await hook({ wake: true })).toEqual({ state: 'not_configured' })
    expect(h.vercel.boxes.get(`orca-test-${id}`)!.status).toBe('stopped')
    await h.call('POST', `/v1/sandboxes/${id}/archive`, { body: {} })
    const res = await h.call('POST', `/v1/sandboxes/${id}/archive-hook`, { body: { wake: true } })
    expect(res).toMatchObject({ status: 409, body: { reason: 'sandbox_archived' } })
    expect((await h.call('GET', `/v1/sandboxes/${id}/archive-hook`)).body.archiveHook.archived).toBe(true)
  })
})

describe('unattended archive (team list, public API)', () => {
  it('runs the hook on a running VM first and archives even when it fails', async () => {
    const { h, id, hookCalls, answer } = await running()
    answer(`ORCA_ARCHIVE_HOOK ${b64('/vercel/sandbox/project')} 1 ${b64('boom\n')}\n`)
    const res = await h.call('PATCH', `/v1/team/workspaces/${id}`, { body: { archived: true } })
    expect(res.status).toBe(200)
    expect(hookCalls).toHaveLength(1)
    // Bounded: the caller waits on the whole request.
    expect(hookCalls[0]!.args![4]).toBe('30')
    expect(h.vercel.boxes.get(`orca-test-${id}`)!.status).toBe('stopped')
  })
})

// The VM runner itself, against a real bash (Linux: /proc, flock, coreutils timeout).
describe.skipIf(process.platform !== 'linux')('archive hook runner (real bash)', () => {
  function vm() {
    const home = mkdtempSync(join(tmpdir(), 'orca-archive-hook-'))
    const project = join(home, 'project')
    mkdirSync(project)
    spawnSync('git', ['init', '-q', project])
    spawnSync('git', ['-C', project, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'])
    // Stands in for orcad: its process env carries the session's secrets.
    const orcad = spawn('sleep', ['60'], { env: { PATH: process.env.PATH, PREVIEW_TOKEN: 'tok-123' }, stdio: 'ignore' })
    mkdirSync(join(home, '.orca-sandbox'))
    writeFileSync(join(home, '.orca-sandbox/orcad.pid'), String(orcad.pid))
    const runner = ARCHIVE_HOOK_SCRIPTS_FOR_TESTS.RUNNER.replaceAll('/vercel/sandbox/project', project)
    const run = (script: string, budget = 10) =>
      spawnSync('bash', ['-c', runner, 'orca-archive-hook', `#!/usr/bin/env bash\nset -e\n${script}\n`, String(budget)], {
        env: { PATH: process.env.PATH, HOME: home },
        encoding: 'utf8'
      })
    return { home, project, run, stop: () => orcad.kill() }
  }

  it('runs in each linked worktree with orcad’s env and the ORCA_* names, and logs it', () => {
    const v = vm()
    try {
      const linked = join(v.home, 'wt-feature')
      spawnSync('git', ['-C', v.project, 'worktree', 'add', '-q', '-b', 'feature', linked])
      const out = v.run('echo "$PREVIEW_TOKEN $ORCA_WORKSPACE_NAME $PWD"; exit 4')
      const [line] = out.stdout.trim().split('\n')
      const [, path, code, output] = line!.split(' ')
      // The primary checkout is skipped once the workspace has a linked worktree.
      expect([Buffer.from(path!, 'base64').toString(), code]).toEqual([linked, '4'])
      expect(Buffer.from(output!, 'base64').toString()).toBe(`tok-123 wt-feature ${linked}\n`)
      expect(readFileSync(join(v.home, '.orca-sandbox/archive-hook/archive.log'), 'utf8')).toContain('orca: archive hook exited 4')
    } finally {
      v.stop()
    }
  })

  it('stops a hook at its budget', () => {
    const v = vm()
    try {
      const out = v.run('sleep 30', 1)
      expect(out.stdout.trim().split(' ')[2]).toBe('124')
    } finally {
      v.stop()
    }
  })
})
