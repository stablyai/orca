import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { mergeAgentHookRequestHeaders } from '../../shared/agent-hook-listener/hook-envelope'
import { parseFormEncodedBody } from '../../shared/agent-hook-listener/request-body'
import { ORCA_HOOK_RAW_JSON_TRANSPORT } from '../../shared/agent-hook-types'
import { getManagedScript } from './codex-hook-script'

type Captured = { headers: IncomingHttpHeaders; body: string }

let server: Server | null = null

afterEach(() => {
  server?.close()
  server = null
})

async function captureOnePost(): Promise<{ port: number; posts: Captured[] }> {
  const posts: Captured[] = []
  server?.close()
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      posts.push({ headers: req.headers, body })
      res.writeHead(204)
      res.end()
    })
  })
  const listening = server
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
  const address = listening.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('capture server has no port')
  }
  return { port: address.port, posts }
}

/**
 * Run the managed hook the way Codex does: through `sh -c`, under a parent
 * whose argv is either the shared daemon's or a plain TUI's.
 */
async function runHookUnder(parentArgs: string[], transport?: string): Promise<Captured[]> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-codex-daemon-hook-'))
  const script = join(dir, 'codex-hook.sh')
  writeFileSync(script, getManagedScript('posix'))
  chmodSync(script, 0o755)
  // Why a file parent: its `ps` args are `/bin/sh <file> <parentArgs...>`, like the daemon's argv.
  const parent = join(dir, 'codex')
  writeFileSync(parent, `/bin/sh -c "/bin/sh '${script}'"\n`)
  const { port, posts } = await captureOnePost()
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ORCA_')) {
      env[key] = value
    }
  }
  const result = await runProcess({
    program: '/bin/sh',
    args: [parent, ...parentArgs],
    env: {
      ...env,
      ORCA_AGENT_HOOK_PORT: String(port),
      ORCA_AGENT_HOOK_TOKEN: 'token',
      ORCA_PANE_KEY: 'tab-sr:11111111-1111-4111-8111-111111111111',
      ORCA_TAB_ID: 'tab-sr',
      ORCA_WORKTREE_ID: 'repo::/work/StudentRegistration',
      ...(transport ? { ORCA_AGENT_HOOK_TRANSPORT: transport } : {})
    },
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'mac-session',
      cwd: '/work/MacOS',
      prompt: 'LATEST MacOS prompt'
    }),
    timeoutMs: 10_000
  })
  expect(result.code).toBe(0)
  return posts
}

function executorOf(post: Captured): unknown {
  const body = post.headers['content-type']?.includes('x-www-form-urlencoded')
    ? parseFormEncodedBody(post.body)
    : JSON.parse(post.body)
  const merged = mergeAgentHookRequestHeaders(body, post.headers)
  return typeof merged === 'object' && merged !== null ? Reflect.get(merged, 'executor') : undefined
}

const DAEMON_ARGS = ['app-server', '--listen', 'unix://', '--managed-daemon']

describe.skipIf(process.platform === 'win32')('managed Codex hook under the shared daemon', () => {
  it('marks form posts that the shared app-server daemon ran', async () => {
    const posts = await runHookUnder(DAEMON_ARGS)
    expect(posts).toHaveLength(1)
    expect(executorOf(posts[0]!)).toBe('codex-shared-daemon')
  })

  it('marks raw-JSON posts that the shared app-server daemon ran', async () => {
    const posts = await runHookUnder(DAEMON_ARGS, ORCA_HOOK_RAW_JSON_TRANSPORT)
    expect(posts).toHaveLength(1)
    expect(executorOf(posts[0]!)).toBe('codex-shared-daemon')
  })

  it('leaves a TUI-run hook unmarked', async () => {
    const posts = await runHookUnder(['--no-daemon'], ORCA_HOOK_RAW_JSON_TRANSPORT)
    expect(posts).toHaveLength(1)
    expect(executorOf(posts[0]!) ?? '').toBe('')
    const formPosts = await runHookUnder(['--no-daemon'])
    expect(executorOf(formPosts[0]!) ?? '').toBe('')
  })
})
