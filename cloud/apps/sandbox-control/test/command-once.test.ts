// runCommand can run a command twice when its POST is retried after the answer was lost
// (github.com/vercel/sandbox/issues/363). The guard (command-once.ts) makes a retry replay the first
// run instead: exercised here with the real guard script under bash, and through message delivery.
import { execFile, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandOutcomeError, ONCE_GUARD, onceInvocation, parseOnceOutput, runCommandOnce } from '../src/command-once'
import { ProviderError, type CommandResult, type RunCommandParams } from '../src/sandbox-provider'
import { createHarness } from './harness'

/** Runs a provider command the way the VM would: argv as given, env on top of a minimal one. */
function runLocally(home: string, params: RunCommandParams): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      params.command,
      params.args ?? [],
      { env: { PATH: process.env.PATH, HOME: home, ...params.env }, cwd: params.cwd },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 0
        resolve({ exitCode: code, stdout, stderr })
      }
    )
  })
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'orca-once-'))
  const effect = join(home, 'effect')
  writeFileSync(effect, '')
  const append = (extra = ''): RunCommandParams => ({
    command: 'bash',
    args: ['-c', `${extra}printf X >> "$1"; echo "ran:$(wc -c < "$1" | tr -d ' ')"`, 'append', effect],
    timeoutMs: 10_000
  })
  const guarded = (id: string, params: RunCommandParams) => runLocally(home, onceInvocation(id, params))
  return { home, effect, append, guarded, effects: () => readFileSync(effect, 'utf8') }
}

describe('the once guard (real bash)', () => {
  it('runs the first time, replays the recorded result on a repeat, never runs twice', async () => {
    const f = fixture()
    const first = parseOnceOutput(await f.guarded('msg-1', f.append()))
    expect(first.state).toBe('ran')
    expect(first.result).toMatchObject({ exitCode: 0, stdout: 'ran:1\n' })
    const again = parseOnceOutput(await f.guarded('msg-1', f.append()))
    expect(again.state).toBe('replayed')
    expect(again.result).toMatchObject({ exitCode: 0, stdout: 'ran:1\n' })
    expect(f.effects()).toBe('X')
    // Another id is another command.
    expect(parseOnceOutput(await f.guarded('msg-2', f.append())).state).toBe('ran')
    expect(f.effects()).toBe('XX')
  })

  it('forgets a failed run, so a retry runs it again', async () => {
    const f = fixture()
    const failing: RunCommandParams = { command: 'bash', args: ['-c', 'printf F >> "$1"; echo nope >&2; exit 3', 'fail', f.effect], timeoutMs: 10_000 }
    const first = parseOnceOutput(await f.guarded('job', failing))
    expect([first.state, first.result.exitCode, first.result.stderr]).toEqual(['ran', 3, 'nope\n'])
    expect(parseOnceOutput(await f.guarded('job', f.append())).state).toBe('ran')
    expect(f.effects()).toBe('FX')
  })

  it('two concurrent attempts: one runs, the other waits and replays it', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([f.guarded('race', f.append('sleep 1; ')), f.guarded('race', f.append('sleep 1; '))])
    const states = [parseOnceOutput(a).state, parseOnceOutput(b).state].sort()
    expect(states).toEqual(['ran', 'replayed'])
    expect(parseOnceOutput(b).result.stdout).toBe(parseOnceOutput(a).result.stdout)
    expect(f.effects()).toBe('X')
  })

  it('a first run that died without a result reports lost, and does not run again', async () => {
    const f = fixture()
    const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim()
    mkdirSync(join(f.home, '.orca-once', 'gone'), { recursive: true })
    writeFileSync(join(f.home, '.orca-once', 'gone', 'pid'), `${dead}\n`)
    expect(parseOnceOutput(await f.guarded('gone', f.append())).state).toBe('lost')
    expect(f.effects()).toBe('')
  })

  it('rejects ids that could escape the ledger directory', () => {
    expect(() => onceInvocation('../x', { command: 'true', timeoutMs: 1000 })).toThrow('invalid_once_id')
    expect(() => onceInvocation('a b', { command: 'true', timeoutMs: 1000 })).toThrow('invalid_once_id')
    expect(onceInvocation('msg_AbC-1.2', { command: 'true', args: ['x'], timeoutMs: 20_000 })).toMatchObject({
      command: 'bash',
      args: ['-c', ONCE_GUARD, 'orca-once', 'msg_AbC-1.2', 'true', 'x'],
      env: { ORCA_ONCE_WAIT: '15' }
    })
  })
})

describe('runCommandOnce', () => {
  it('a POST whose answer was lost is retried with the same id: the command ran once, the retry replays it', async () => {
    const f = fixture()
    let posts = 0
    const lossy = {
      async runCommand(_session: string, params: RunCommandParams) {
        posts++
        const result = await runLocally(f.home, params)
        if (posts === 1) {
          // Vercel started (and finished) the command, then the connection dropped before the answer.
          throw new TypeError('Network connection lost.')
        }
        return result
      }
    }
    const result = await runCommandOnce(lossy, 'sess', 'msg-lost-answer', f.append(), { sleep: async () => undefined })
    expect(posts).toBe(2)
    expect(result).toMatchObject({ state: 'replayed', attempts: 2, exitCode: 0, stdout: 'ran:1\n' })
    expect(f.effects()).toBe('X')
  })

  it('a gateway 5xx after the command started is retried the same way', async () => {
    const f = fixture()
    let posts = 0
    const flaky = {
      async runCommand(_session: string, params: RunCommandParams) {
        posts++
        const result = await runLocally(f.home, params)
        if (posts < 3) {
          throw new ProviderError(502, null)
        }
        return result
      }
    }
    const result = await runCommandOnce(flaky, 'sess', 'msg-5xx', f.append(), { sleep: async () => undefined })
    expect([posts, result.state, f.effects()]).toEqual([3, 'replayed', 'X'])
  })

  it('never retries a failure that proves the command did not start, and gives up after its attempts', async () => {
    let posts = 0
    const stopped = {
      async runCommand() {
        posts++
        throw new ProviderError(410, 'sandbox_stopped')
      }
    }
    await expect(runCommandOnce(stopped, 'sess', 'x', { command: 'true', timeoutMs: 1000 }, { sleep: async () => undefined })).rejects.toThrow(ProviderError)
    expect(posts).toBe(1)
    posts = 0
    const down = {
      async runCommand() {
        posts++
        throw new ProviderError(503, null)
      }
    }
    await expect(runCommandOnce(down, 'sess', 'x', { command: 'true', timeoutMs: 1000 }, { sleep: async () => undefined })).rejects.toThrow(ProviderError)
    expect(posts).toBe(3)
  })

  it('a lost first run surfaces as an unknown outcome, never as a re-run', async () => {
    const f = fixture()
    const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim()
    mkdirSync(join(f.home, '.orca-once', 'msg-dead'), { recursive: true })
    writeFileSync(join(f.home, '.orca-once', 'msg-dead', 'pid'), dead)
    const vm = { runCommand: (_s: string, params: RunCommandParams) => runLocally(f.home, params) }
    await expect(runCommandOnce(vm, 'sess', 'msg-dead', f.append())).rejects.toThrow(CommandOutcomeError)
    expect(f.effects()).toBe('')
  })

  it('the Vercel REST client itself sends a command POST exactly once, even when it fails', async () => {
    const { createVercelSandboxApi } = await import('../src/vercel-sandbox-api')
    let posts = 0
    const api = createVercelSandboxApi({
      token: 't',
      teamId: 'team',
      projectId: 'p',
      fetch: (async () => {
        posts++
        throw new TypeError('Network connection lost.')
      }) as unknown as typeof fetch
    })
    await expect(api.runCommand('sess', { command: 'true', timeoutMs: 1000 })).rejects.toThrow(TypeError)
    expect(posts).toBe(1)
  })
})

describe('message delivery', () => {
  async function harness() {
    const pending: Promise<unknown>[] = []
    const h = await createHarness({ PUBLIC_API_URL: 'https://api.test' }, { waitUntil: (p) => void pending.push(p) })
    let typed = 0
    let launched = 0
    h.vercel.commandHandler = (params) => {
      const args = params.args ?? []
      if (args.includes('launch')) {
        launched++
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { outcome: { kind: 'terminal', handle: `term_${launched}` } } }), stderr: '' }
      }
      if (args.includes('send')) {
        typed++
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' }
      }
      return undefined
    }
    // The provider runs the command, then the answer is lost (once).
    const runCommand = h.vercel.runCommand
    let drops = 0
    const dropNextAnswer = () => {
      drops = 1
    }
    h.vercel.runCommand = async (sessionId, params) => {
      const result = await runCommand(sessionId, params)
      if (drops > 0 && params.args?.[1] === ONCE_GUARD) {
        drops--
        throw new ProviderError(502, null)
      }
      return result
    }
    return { h, settle: () => Promise.all(pending.splice(0)), counts: () => ({ typed, launched }), dropNextAnswer }
  }

  it('a message whose delivery answer was lost is typed into the agent once and still reported delivered', async () => {
    const { h, settle, counts, dropNextAnswer } = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    const first = await h.call('POST', `/v1/workspaces/${ws.id}/messages`, { body: { text: 'start' } })
    await settle()
    const session = (await h.call('GET', `/v1/workspaces/${ws.id}/messages/${first.body.message.id}`)).body.message.session
    expect([session, counts()]).toEqual(['term_1', { typed: 0, launched: 1 }])

    dropNextAnswer()
    const next = await h.call('POST', `/v1/workspaces/${ws.id}/messages`, { body: { text: 'run the tests', session } })
    await settle()
    expect((await h.call('GET', `/v1/workspaces/${ws.id}/messages/${next.body.message.id}`)).body.message).toMatchObject({ status: 'delivered', attempts: 1 })
    expect(counts()).toEqual({ typed: 1, launched: 1 })
  })

  it('a launch whose answer was lost starts one agent, not two', async () => {
    const { h, settle, counts, dropNextAnswer } = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    dropNextAnswer()
    const sent = await h.call('POST', `/v1/workspaces/${ws.id}/messages`, { body: { text: 'hello' } })
    await settle()
    expect((await h.call('GET', `/v1/workspaces/${ws.id}/messages/${sent.body.message.id}`)).body.message).toMatchObject({ status: 'delivered', session: 'term_1' })
    expect(counts()).toEqual({ typed: 0, launched: 1 })
  })

  it('a retried POST with the same Idempotency-Key gets the first message back instead of sending another', async () => {
    const { h, settle, counts } = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    const headers = { 'idempotency-key': 'retry-key-0001' }
    const a = await h.call('POST', `/v1/workspaces/${ws.id}/messages`, { body: { text: 'once' }, headers })
    await settle()
    const b = await h.call('POST', `/v1/workspaces/${ws.id}/messages`, { body: { text: 'once' }, headers })
    await settle()
    expect([a.status, b.status]).toEqual([202, 202])
    expect(b.body.message.id).toBe(a.body.message.id)
    expect(counts()).toEqual({ typed: 0, launched: 1 })
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM workspace_messages').get()).toEqual({ n: 1 })
  })

  it('a retried session create with the same Idempotency-Key returns the first session', async () => {
    const { h, counts } = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    const headers = { 'idempotency-key': 'session-key-0001' }
    const a = await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, { body: { agent: 'claude' }, headers })
    const b = await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, { body: { agent: 'claude' }, headers })
    expect([a.status, b.status]).toEqual([201, 201])
    expect(b.body.session.handle).toBe(a.body.session.handle)
    expect(counts().launched).toBe(1)
  })
})
