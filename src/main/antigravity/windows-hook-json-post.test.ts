import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT } from './windows-hook-json-post'

const directory = mkdtempSync(join(tmpdir(), 'orca-agy-json-post-'))
const script = join(directory, 'hook.cjs')
writeFileSync(script, WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT)
afterAll(() => rmSync(directory, { recursive: true, force: true }))

it('delivers exact split UTF-8 JSON without EOF and bounds empty or partial input', async () => {
  const posts: URLSearchParams[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      posts.push(new URLSearchParams(body))
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing listener')
  }
  const env = {
    ...process.env,
    ORCA_AGENT_HOOK_PORT: String(address.port),
    ORCA_AGENT_HOOK_TOKEN: 'disposable-proof-token',
    ORCA_PANE_KEY: 'proof!pane',
    ORCA_ANTIGRAVITY_EVENT: 'PreInvocation'
  }
  const payload = JSON.stringify({
    message: '日本語 😀 café {"quoted"} \\ tail',
    transcript: 'x'.repeat(100_000)
  })
  try {
    for (const input of [payload, '', '{"partial":', '{} trailing-data']) {
      const child = spawnProcess({ program: process.execPath, args: [script], env })
      child.stdin.on('error', () => {})
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      const timer = setTimeout(() => child.kill(), 9000)
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve)
        child.once('error', reject)
      })
      const before = posts.length
      if (input) {
        const bytes = Buffer.from(input)
        const cut = bytes.indexOf(Buffer.from('日本語')) + 1
        child.stdin.write(bytes.subarray(0, Math.max(1, cut)))
        await new Promise((resolve) => setTimeout(resolve, 25))
        child.stdin.write(bytes.subarray(Math.max(1, cut)))
      }
      expect(await closed).toBe(0)
      clearTimeout(timer)
      child.stdin.destroy()
      expect(stdout).toBe('')
      expect(stderr).toBe('')
      expect(posts.slice(before)).toHaveLength(1)
      expect(posts[before].get('payload')).toBe(input || '{}')
      expect(posts[before].get('paneKey')).toBe('proof!pane')
      expect(posts[before].get('hook_event_name')).toBe('PreInvocation')
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 20_000)

it('bounds oversized payloads, encoded bodies, absent endpoints and stalled HTTP', async () => {
  let requests = 0
  const server = createServer((request) => {
    requests++
    request.resume()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing listener')
  }
  const env = {
    ...process.env,
    ORCA_AGENT_HOOK_PORT: String(address.port),
    ORCA_AGENT_HOOK_TOKEN: 'disposable-proof-token',
    ORCA_PANE_KEY: 'proof-pane'
  }
  try {
    for (const payloadCase of ['oversized', 'encoded-oversized', 'no-endpoint', 'hung-http']) {
      const before = requests
      const child = spawnProcess({
        program: process.execPath,
        args: [script],
        env: payloadCase === 'no-endpoint' ? { ...env, ORCA_AGENT_HOOK_PORT: '' } : env
      })
      child.stdin.on('error', () => {})
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      const timer = setTimeout(() => child.kill(), 4000)
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve)
        child.once('error', reject)
      })
      if (payloadCase !== 'no-endpoint') {
        child.stdin.write(
          JSON.stringify({
            text:
              payloadCase === 'oversized'
                ? 'x'.repeat(1_000_001)
                : payloadCase === 'encoded-oversized'
                  ? '日'.repeat(150_000)
                  : 'hung-request'
          })
        )
      }
      expect(await closed, payloadCase).toBe(0)
      clearTimeout(timer)
      child.stdin.destroy()
      expect(output, payloadCase).toBe('')
      expect(requests - before, payloadCase).toBe(payloadCase === 'hung-http' ? 1 : 0)
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 15_000)
