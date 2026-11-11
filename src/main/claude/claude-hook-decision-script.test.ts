import { spawn } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { getManagedScript } from './hook-script'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  )
})

type Seen = { headers: IncomingHttpHeaders }[]

async function hookServer(reply: (seen: Seen[number]) => string | null) {
  const seen: Seen = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ headers: req.headers })
      const body = reply({ headers: req.headers })
      res.writeHead(body ? 200 : 204, body ? { 'content-type': 'application/json' } : {})
      res.end(body ?? undefined)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { port: typeof address === 'object' && address ? address.port : 0, seen }
}

function runHook(
  stdin: string,
  env: Record<string, string>,
  decidesPreToolUse = true
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', getManagedScript('posix', { decidesPreToolUse })], {
      env: {
        PATH: process.env.PATH ?? '',
        ORCA_AGENT_HOOK_TOKEN: 'token',
        ORCA_PANE_KEY: 'tab-1:0',
        ...env
      }
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.on('error', reject)
    child.on('close', () => resolve(out))
    child.stdin.end(stdin)
  })
}

const PRE = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })
const POST = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} })
const DENY =
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"acme.guard: no"}}'

describe.skipIf(process.platform === 'win32')(
  'Claude PreToolUse decisions in the hook script',
  () => {
    it('prints Orca’s decision for PreToolUse, over either transport', async () => {
      const { port, seen } = await hookServer(() => DENY)
      expect(await runHook(PRE, { ORCA_AGENT_HOOK_PORT: String(port) })).toBe(`${DENY}\n`)
      expect(
        await runHook(PRE, {
          ORCA_AGENT_HOOK_PORT: String(port),
          ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1'
        })
      ).toBe(`${DENY}\n`)
      expect(seen.map(({ headers }) => headers['x-orca-hook-decision'])).toEqual([
        'claude-pre-tool-use-v1',
        'claude-pre-tool-use-v1'
      ])
    })

    it('prints {} with no decision, for other events, and when Orca is unreachable', async () => {
      const { port, seen } = await hookServer(() => null)
      expect(await runHook(PRE, { ORCA_AGENT_HOOK_PORT: String(port) })).toBe('{}\n')
      expect(await runHook(POST, { ORCA_AGENT_HOOK_PORT: String(port) })).toBe('{}\n')
      // curl drops a header whose value is empty.
      expect(seen[1]?.headers['x-orca-hook-decision']).toBeUndefined()
      const closed = await hookServer(() => null)
      await new Promise((resolve) => servers.pop()?.close(resolve))
      expect(await runHook(PRE, { ORCA_AGENT_HOOK_PORT: String(closed.port) })).toBe('{}\n')
    })

    it('never prints a reply that is not a PreToolUse decision', async () => {
      const { port } = await hookServer(() => '{"error":"nope"}')
      expect(await runHook(PRE, { ORCA_AGENT_HOOK_PORT: String(port) })).toBe('{}\n')
    })

    it('prints {} when curl fails after part of a decision arrived', async () => {
      const server = createServer((req, res) => {
        req.resume()
        req.on('end', () => {
          res.writeHead(200, { 'content-length': String(DENY.length) })
          res.write(DENY.slice(0, 60), () => res.destroy())
        })
      })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      expect(await runHook(PRE, { ORCA_AGENT_HOOK_PORT: String(port) })).toBe('{}\n')
    })

    it('keeps print-then-post for CLIs reusing Claude’s script, such as OpenClaude', async () => {
      const { port, seen } = await hookServer(() => DENY)
      expect(await runHook(PRE, { ORCA_AGENT_HOOK_PORT: String(port) }, false)).toBe('{}\n')
      expect(seen).toHaveLength(1)
      expect(seen[0]?.headers['x-orca-hook-decision']).toBeUndefined()
    })
  }
)
