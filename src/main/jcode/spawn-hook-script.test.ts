import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseJcodeSpawnRequest } from '../../shared/jcode-spawn-hook'
import { buildJcodeSpawnHookScript } from './spawn-hook-script'

describe.skipIf(process.platform === 'win32')('POSIX Jcode spawn hook', () => {
  let dir: string
  let script: string
  let server: Server
  let env: NodeJS.ProcessEnv
  let status: number
  let hang: boolean
  let requests: { method?: string; path?: string; token: unknown; body: Record<string, string> }[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-jcode-spawn-'))
    script = join(dir, 'spawn.sh')
    writeFileSync(script, buildJcodeSpawnHookScript('posix'))
    chmodSync(script, 0o755)
    status = 200
    hang = false
    requests = []
    server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
      }
      requests.push({
        method: request.method,
        path: request.url,
        token: request.headers['x-orca-agent-hook-token'],
        body: Object.fromEntries(new URLSearchParams(body))
      })
      if (!hang) {
        response.writeHead(status).end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address')
    }
    env = {
      PATH: process.env.PATH,
      ORCA_AGENT_HOOK_PORT: String(address.port),
      ORCA_AGENT_HOOK_TOKEN: randomBytes(32).toString('hex'),
      ORCA_PANE_KEY: 'tab_a:11111111-1111-4111-8111-111111111111',
      ORCA_JCODE_PANE_SECRET: randomBytes(32).toString('hex'),
      ORCA_TAB_ID: 'tab_a',
      ORCA_AGENT_LAUNCH_TOKEN: randomBytes(32).toString('hex'),
      ORCA_WORKTREE_ID: 'test-worktree',
      JCODE_SPAWN_KIND: 'swarm-agent',
      JCODE_SPAWN_SESSION_ID: 'session_piglet_1792604760697_211acdce5650ace5',
      JCODE_SPAWN_COORDINATOR_SESSION_ID: 'session_pawprint_1792604760602_81cf383ab5bbf2d4',
      JCODE_SPAWN_TITLE: '🐽 jcode/castle Piglet',
      JCODE_SPAWN_COMMAND:
        "'/home/user/.local/bin/jcode' '--fresh-spawn' '--provider' 'claude' '--resume' 'session_piglet_1792604760697_211acdce5650ace5'",
      JCODE_SPAWN_CWD: dir,
      JCODE_RUNTIME_DIR: join(dir, 'runtime')
    }
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    rmSync(dir, { recursive: true, force: true })
  })

  function run() {
    const start = performance.now()
    return new Promise<{ code: number | string; stderr: string; elapsed: number }>((resolve) => {
      execFile('/bin/sh', [script], { env, timeout: 3000 }, (error, _stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stderr, elapsed: performance.now() - start })
      })
    })
  }

  function expectRoundTrip() {
    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/jcode-spawn')
    expect('tabId' in request.body || 'launchToken' in request.body).toBe(false)
    expect(request.token === env.ORCA_AGENT_HOOK_TOKEN).toBe(true)
    const expected = {
      paneKey: env.ORCA_PANE_KEY,
      paneSecret: env.ORCA_JCODE_PANE_SECRET,
      worktreeId: env.ORCA_WORKTREE_ID,
      kind: env.JCODE_SPAWN_KIND,
      command: env.JCODE_SPAWN_COMMAND,
      sessionId: env.JCODE_SPAWN_SESSION_ID,
      coordinatorSessionId: env.JCODE_SPAWN_COORDINATOR_SESSION_ID,
      title: env.JCODE_SPAWN_TITLE,
      cwd: env.JCODE_SPAWN_CWD,
      runtimeDir: env.JCODE_RUNTIME_DIR
    }
    // Keep generated authority values out of assertion diffs.
    expect(JSON.stringify(parseJcodeSpawnRequest(request.body)) === JSON.stringify(expected)).toBe(
      true
    )
  }

  function expectFailure(result: Awaited<ReturnType<typeof run>>) {
    expect(result.code).toBe(1)
    expect(result.elapsed).toBeLessThan(2000)
    expect(result.stderr).toBe('orca: jcode spawn hook was not accepted by Orca\n')
  }

  it('posts captured piglet fields and exits successfully on acceptance', async () => {
    expect((await run()).code).toBe(0)
    expectRoundTrip()
  })

  it('keeps pane authority out of curl argv while preserving request bytes', async () => {
    const curl = join(dir, 'curl')
    const check = join(dir, 'argv-check')
    writeFileSync(
      curl,
      [
        '#!/bin/sh',
        'printf safe > "$ORCA_TEST_ARGV_CHECK"',
        'for arg do',
        '  case "$arg" in',
        '    *"$ORCA_JCODE_PANE_SECRET"*|*"$ORCA_AGENT_LAUNCH_TOKEN"*) printf exposed > "$ORCA_TEST_ARGV_CHECK" ;;',
        '  esac',
        'done',
        'PATH="$ORCA_TEST_ORIGINAL_PATH" exec curl "$@"',
        ''
      ].join('\n')
    )
    chmodSync(curl, 0o755)
    env.ORCA_TEST_ARGV_CHECK = check
    env.ORCA_TEST_ORIGINAL_PATH = env.PATH
    env.PATH = `${dir}:${env.PATH}`
    env.ORCA_JCODE_PANE_SECRET += '\n'
    expect((await run()).code).toBe(0)
    expect(readFileSync(check, 'utf8')).toBe('safe')
    expectRoundTrip()
  })

  it('preserves hostile title and multiline command byte-exact without executing either', async () => {
    env.JCODE_SPAWN_TITLE = 'a\'b"c $HOME `x` &%20 \n line2 🐽'
    env.JCODE_SPAWN_COMMAND = "printf '%s' 'one'\nexit 99"
    expect((await run()).code).toBe(0)
    expectRoundTrip()
  })

  it('sources endpoint file before using stale environment', async () => {
    const endpoint = join(dir, 'endpoint.sh')
    const refreshedToken = env.ORCA_AGENT_HOOK_TOKEN
    writeFileSync(
      endpoint,
      `export ORCA_AGENT_HOOK_PORT=${env.ORCA_AGENT_HOOK_PORT}\nexport ORCA_AGENT_HOOK_TOKEN=${env.ORCA_AGENT_HOOK_TOKEN}\n`
    )
    env.ORCA_AGENT_HOOK_ENDPOINT = endpoint
    env.ORCA_AGENT_HOOK_PORT = '1'
    env.ORCA_AGENT_HOOK_TOKEN = randomBytes(32).toString('hex')
    expect((await run()).code).toBe(0)
    expect(requests).toHaveLength(1)
    expect(requests[0].token === refreshedToken).toBe(true)
  })

  it('fails inside Jcode launch window when Orca is unreachable', async () => {
    env.ORCA_AGENT_HOOK_PORT = '0'
    expectFailure(await run())
    expect(requests).toHaveLength(0)
  })

  it.each([
    'ORCA_AGENT_HOOK_PORT',
    'ORCA_AGENT_HOOK_TOKEN',
    'ORCA_PANE_KEY',
    'ORCA_JCODE_PANE_SECRET',
    'JCODE_SPAWN_SESSION_ID'
  ])('fails without %s and sends no request', async (key) => {
    delete env[key]
    expectFailure(await run())
    expect(requests).toHaveLength(0)
  })

  it.each([302, 403, 400, 503])('fails on HTTP %s', async (code) => {
    status = code
    expectFailure(await run())
    expect(requests).toHaveLength(1)
  })

  it('times out an unanswered request before Jcode assumes successful launch', async () => {
    hang = true
    const result = await run()
    expectFailure(result)
    expect(result.elapsed).toBeGreaterThanOrEqual(1500)
    expect(requests).toHaveLength(1)
  })
})

it('builds Windows spawn hook with endpoint refresh and explicit exit contract', () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  try {
    const script = buildJcodeSpawnHookScript()
    expect(script.startsWith('@echo off')).toBe(true)
    expect(script.includes('ORCA_TAB_ID') || script.includes('ORCA_AGENT_LAUNCH_TOKEN')).toBe(false)
    for (const text of [
      '/jcode-spawn',
      'JCODE_SPAWN_SESSION_ID',
      'JCODE_RUNTIME_DIR',
      'ORCA_JCODE_PANE_SECRET',
      'call "%ORCA_AGENT_HOOK_ENDPOINT%"',
      '--fail',
      'exit /b 1',
      'exit /b 0'
    ]) {
      expect(script).toContain(text)
    }
  } finally {
    platform.mockRestore()
  }
})
