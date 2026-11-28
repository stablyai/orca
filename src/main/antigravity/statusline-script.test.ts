import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAntigravityStatusLineScript } from './statusline-script'

type Post = { token: string | string[] | undefined; body: string }

const TOKEN = 'test-token'
const PANE = 'tab-1:11111111-2222-3333-4444-555555555555'
const QUOTA = { 'gemini-5h': { remaining_fraction: 0.5, reset_time: '2026-11-28T12:00:00Z' } }
const MODEL = { id: 'm', display_name: 'Gemini 4 Neon (High)', effort: 'high' }

let dir: string
let server: Server
let port: number
let posts: Post[]
let holdResponses: boolean
let releaseResponses: (() => void)[]
let responded: number
let closedRequests: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-script-'))
  posts = []
  holdResponses = false
  releaseResponses = []
  responded = 0
  closedRequests = 0
  server = createServer((req, res) => {
    req.socket.on('close', () => (closedRequests += 1))
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      posts.push({ token: req.headers['x-orca-agent-hook-token'], body })
      const reply = (): void => {
        responded += 1
        res.writeHead(204).end()
      }
      if (holdResponses) {
        releaseResponses.push(reply)
      } else {
        reply()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('test server has no TCP port')
  }
  port = address.port
})

afterEach(async () => {
  releaseResponses.forEach((release) => release())
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

function writeScript(original: string | null): string {
  const path = join(dir, 'statusline.sh')
  writeFileSync(path, getAntigravityStatusLineScript(original))
  chmodSync(path, 0o755)
  return path
}

function run(
  script: string,
  stdin: string,
  env: Record<string, string> = {}
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [script], {
      env: { PATH: process.env.PATH ?? '', TMPDIR: dir, ...env }
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('close', (code) => resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code }))
    child.stdin.end(stdin)
  })
}

function orcaEnv(pane = PANE): Record<string, string> {
  return {
    ORCA_AGENT_HOOK_PORT: String(port),
    ORCA_AGENT_HOOK_TOKEN: TOKEN,
    ORCA_PANE_KEY: pane
  }
}

// Proving no POST happens needs a quiet period; a detached curl has nothing to await.
async function settle(ms = 700): Promise<void> {
  // ast-grep-ignore: test-no-real-time-wait -- absence of a background POST can only be shown by waiting past a localhost round trip
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// The script runs through a POSIX shell, which agy only does on macOS and Linux.
describe.skipIf(process.platform === 'win32')('Antigravity status-line script', () => {
  it.each([
    ['a JSON line with a trailing newline', '{"quota":1,"name":"ünï"}\n'],
    ['JSON without a trailing newline', '{"quota":1}'],
    ['blank lines and backslashes', '\n\nline \\n one\n\n']
  ])('hands the original command %s byte for byte', async (_name, stdin) => {
    const original = "printf 'left|'; cat; printf '|right\\n'; exit 7"
    const direct = spawnSync('sh', ['-c', original], { input: stdin })
    const wrapped = await run(writeScript(original), stdin, orcaEnv())
    expect(Buffer.from(wrapped.stdout)).toEqual(direct.stdout)
    expect(wrapped.code).toBe(direct.status)
    expect(wrapped.code).toBe(7)
  })

  it('keeps stdin a pipe for the original command', async () => {
    const original = '[ -p /dev/stdin ] && printf pipe || printf other'
    expect((await run(writeScript(original), '{}')).stdout).toBe('pipe')
  })

  it.each([
    [
      'mode, model and effort',
      { cycle_mode: 'auto', model: MODEL, terminal_width: 111 },
      `? for shortcuts${' '.repeat(69)}auto · Gemini 4 Neon · high\n`
    ],
    [
      'mode and model without effort',
      { cycle_mode: 'auto', model: { display_name: 'Gemini 4 Neon' }, terminal_width: 60 },
      `? for shortcuts${' '.repeat(25)}auto · Gemini 4 Neon\n`
    ],
    [
      'only the mode',
      { cycle_mode: 'auto', terminal_width: 40 },
      `? for shortcuts${' '.repeat(21)}auto\n`
    ],
    ['nothing to show', { terminal_width: 40 }, '? for shortcuts\n']
  ])('prints the default footer row for an empty slot with %s', async (_name, payload, row) => {
    const result = await run(writeScript(null), JSON.stringify(payload))
    expect(result.stdout).toBe(row)
    expect(result.code).toBe(0)
  })

  it('posts once per pane per window, and only when the payload has quota', async () => {
    const script = writeScript(null)
    const withQuota = JSON.stringify({ quota: QUOTA, cycle_mode: 'auto', model: MODEL })
    await run(script, withQuota, orcaEnv())
    await expect.poll(() => posts.length).toBe(1)
    expect(posts[0].token).toBe(TOKEN)
    expect(decodeURIComponent(posts[0].body.replace(/\+/g, ' '))).toContain(`payload=${withQuota}`)
    expect(posts[0].body).toContain('paneKey=tab-1%3A11111111')

    await run(script, withQuota, orcaEnv())
    await settle()
    expect(posts).toHaveLength(1)

    const otherPane = 'tab-2:99999999-2222-3333-4444-555555555555'
    await run(script, JSON.stringify({ cycle_mode: 'auto', model: MODEL }), orcaEnv(otherPane))
    await settle()
    expect(posts).toHaveLength(1)

    await run(script, withQuota, orcaEnv(otherPane))
    await expect.poll(() => posts.length).toBe(2)
  })

  it('posts nothing but still prints outside Orca', async () => {
    const result = await run(
      writeScript(null),
      JSON.stringify({ quota: QUOTA, cycle_mode: 'auto', model: MODEL, terminal_width: 60 })
    )
    await settle()
    expect(posts).toHaveLength(0)
    expect(result.stdout.startsWith('? for shortcuts')).toBe(true)
  })

  it('leaves the post running in the background when the script exits', async () => {
    holdResponses = true
    const result = await run(writeScript("printf 'x'"), JSON.stringify({ quota: QUOTA }), orcaEnv())
    // A post made in the foreground would time out and hang up before the script returned.
    expect(closedRequests).toBe(0)
    expect(result.stdout).toBe('x')
    await expect.poll(() => posts.length).toBe(1)
  })

  it('does not mistake a string value for the model key', async () => {
    const payload = {
      conversation_title: 'model',
      cycle_mode: 'auto',
      model: MODEL,
      terminal_width: 60
    }
    const result = await run(writeScript(null), JSON.stringify(payload))
    expect(result.stdout).toBe(`? for shortcuts${' '.repeat(18)}auto · Gemini 4 Neon · high\n`)
  })

  it('stops posting once the feature is off while still running the user command', async () => {
    const script = join(dir, 'passthrough.sh')
    writeFileSync(script, getAntigravityStatusLineScript("printf 'mine'", { forwardQuota: false }))
    const result = await run(script, JSON.stringify({ quota: QUOTA }), orcaEnv())
    await settle()
    expect(result.stdout).toBe('mine')
    expect(posts).toHaveLength(0)
  })
})
