import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAntigravityStatusLineScript } from './statusline-script'

type Post = { token: string | undefined; body: string }

const TOKEN = 'test-token'
const PANE = 'tab-1:11111111-2222-3333-4444-555555555555'
const QUOTA = { 'gemini-5h': { remaining_fraction: 0.5, reset_time: '2026-11-28T12:00:00Z' } }
const MODEL = { id: 'm', display_name: 'Gemini 4 Neon (High)', effort: 'high' }

let dir: string
let server: Server
let posts: Post[]
let responseDelayMs: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-script-'))
  posts = []
  responseDelayMs = 0
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      posts.push({ token: req.headers['x-orca-agent-hook-token'] as string | undefined, body })
      setTimeout(() => res.writeHead(204).end(), responseDelayMs)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterEach(async () => {
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
): Promise<{ stdout: string; code: number | null; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('/bin/sh', [script], {
      env: { PATH: process.env.PATH ?? '', TMPDIR: dir, ...env }
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('close', (code) =>
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code, ms: Date.now() - started })
    )
    child.stdin.end(stdin)
  })
}

function orcaEnv(pane = PANE): Record<string, string> {
  return {
    ORCA_AGENT_HOOK_PORT: String((server.address() as AddressInfo).port),
    ORCA_AGENT_HOOK_TOKEN: TOKEN,
    ORCA_PANE_KEY: pane
  }
}

async function settle(ms = 700): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Antigravity status-line script', () => {
  it('passes the original command stdout and exit code through unchanged', async () => {
    const original = "printf 'left|'; cat; printf '|right\\n'; exit 7"
    const stdin = JSON.stringify({ quota: QUOTA, name: 'ünï' })
    const direct = spawnSync('sh', ['-c', original], { input: stdin })
    const wrapped = await run(writeScript(original), stdin, orcaEnv())
    expect(Buffer.from(wrapped.stdout)).toEqual(direct.stdout)
    expect(wrapped.code).toBe(7)
    expect(wrapped.stdout).toBe(`left|${stdin}|right\n`)
    expect(
      readdirSync(dir).filter((name) => name.startsWith('orca-antigravity-statusline.'))
    ).toEqual([])
  })

  it('prints a default-style footer row for an empty slot', async () => {
    const script = writeScript(null)
    const full = JSON.stringify({ cycle_mode: 'auto', model: MODEL, terminal_width: 111 })
    const withRow = await run(script, full)
    expect(withRow.stdout).toBe(`? for shortcuts${' '.repeat(69)}auto · Gemini 4 Neon · high\n`)
    const noModel = await run(script, JSON.stringify({ cycle_mode: 'auto', terminal_width: 111 }))
    expect(noModel.stdout).toBe('? for shortcuts\n')
    expect(noModel.code).toBe(0)
  })

  it('posts once per pane per window, and only when the payload has quota', async () => {
    const script = writeScript(null)
    const withQuota = JSON.stringify({ quota: QUOTA, cycle_mode: 'auto', model: MODEL })
    await run(script, withQuota, orcaEnv())
    await settle()
    expect(posts).toHaveLength(1)
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
    await settle()
    expect(posts).toHaveLength(2)
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

  it('returns before a slow server answers', async () => {
    responseDelayMs = 2000
    const result = await run(writeScript("printf 'x'"), JSON.stringify({ quota: QUOTA }), orcaEnv())
    expect(result.ms).toBeLessThan(200)
    expect(result.stdout).toBe('x')
    await settle()
    expect(posts).toHaveLength(1)
  })
})
