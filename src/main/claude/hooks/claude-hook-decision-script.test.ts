import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getManagedScript } from './hook-script'

const DENY = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'

describe.skipIf(process.platform === 'win32')('Claude decision hook script', () => {
  let server: Server
  let port = 0
  let reply = ''
  const posts: { decision: string | undefined; body: string }[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const decision = req.headers['x-orca-hook-decision']
        posts.push({ decision: typeof decision === 'string' ? decision : undefined, body })
        res.end(reply)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    port = typeof address === 'object' && address !== null ? address.port : 0
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  async function runHook(event: string, serverReply: string, serverPort = port) {
    const home = mkdtempSync(join(tmpdir(), 'orca-claude-decision-'))
    try {
      const endpoint = join(home, 'endpoint.env')
      writeFileSync(endpoint, `ORCA_AGENT_HOOK_PORT=${serverPort}\nORCA_AGENT_HOOK_TOKEN=t\n`)
      const script = join(home, 'claude-hook.sh')
      writeFileSync(script, getManagedScript('posix', { decidesPreToolUse: true }))
      chmodSync(script, 0o755)
      reply = serverReply
      posts.length = 0
      const stdout = await new Promise<string>((resolve) => {
        const child = spawn('/bin/sh', [script], {
          env: {
            PATH: '/usr/bin:/bin',
            HOME: home,
            ORCA_AGENT_HOOK_ENDPOINT: endpoint,
            ORCA_PANE_KEY: 'tab-1:0'
          }
        })
        let out = ''
        child.stdout.on('data', (chunk) => (out += chunk))
        child.on('close', () => resolve(out))
        child.stdin.end(`{"hook_event_name":"${event}","session_id":"s"}`)
      })
      return { stdout, posts: [...posts], spooled: existsSync(join(home, 'spool')) }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('prints a decision only for the event that asked, and still posts every event', async () => {
    const decided = await runHook('PreToolUse', DENY)
    expect(decided.stdout).toBe(`${DENY}\n`)
    expect(decided.posts.map((post) => post.decision)).toEqual(['claude-pre-tool-use-v1'])

    // A non-decision event discards the reply without the capture subshell, even a decision-shaped one.
    const notified = await runHook('PostToolUse', DENY)
    expect(notified.stdout).toBe('{}\n')
    expect(notified.posts).toHaveLength(1)
    expect(notified.posts[0].decision).toBeUndefined()
    expect(notified.posts[0].body).toContain('PostToolUse')
  })

  it('spools a non-decision event when Orca is down', async () => {
    const result = await runHook('Stop', '', 9)
    expect(result.stdout).toBe('{}\n')
    expect(result.spooled).toBe(true)
  })
})
