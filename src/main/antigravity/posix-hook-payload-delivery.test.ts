import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { getManagedScript } from './hook-script'

const PAYLOAD = JSON.stringify({ hook_event_name: 'Stop', result: 'café 日本語 😀'.repeat(4000) })

async function runHook(options: {
  chunks: string[]
  close: boolean
  gapMs?: number
  noPython?: boolean
  offline?: boolean
}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-agy-stdin-'))
  const posts: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (part) => {
      body += part
    })
    req.on('end', () => {
      posts.push(new URLSearchParams(body).get('payload') ?? '')
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('listener unavailable')
  }
  const endpoint = join(root, 'endpoint.sh')
  writeFileSync(endpoint, '# isolated endpoint\n')
  const env = {
    ...process.env,
    ORCA_ANTIGRAVITY_EVENT: 'Stop',
    ORCA_PANE_KEY: 'probe-pane',
    ORCA_AGENT_HOOK_ENDPOINT: endpoint,
    ORCA_AGENT_HOOK_PORT: options.offline ? '' : String(address.port),
    ORCA_AGENT_HOOK_TOKEN: options.offline ? '' : 'isolated-token'
  }
  let script = getManagedScript('posix')
  if (options.noPython) {
    // Simulate unavailable interpreters without changing the host's binaries or PATH.
    script = script.replaceAll('command -p python', 'command -p orca_missing_python')
  }
  const child = spawnProcess({ program: '/bin/sh', args: ['-c', script], env, detached: true })
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.on('data', (part) => {
    stdout += part
  })
  child.stderr.on('data', (part) => {
    stderr += part
  })
  child.stdin.on('error', () => {})
  const timeout = setTimeout(() => {
    timedOut = true
    if (child.pid) {
      process.kill(-child.pid, 'SIGKILL')
    }
  }, 8000)
  try {
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    for (const [index, chunk] of options.chunks.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.gapMs ?? 0))
      }
      child.stdin.write(chunk)
    }
    if (options.close) {
      child.stdin.end()
    }
    const code = await exited
    let descendantsRemain = false
    if (child.pid) {
      try {
        process.kill(-child.pid, 0)
        descendantsRemain = true
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The hook's process group is gone.
      }
    }
    const spoolDir = join(root, 'spool')
    let spooled: string[] = []
    try {
      spooled = readdirSync(spoolDir).map((name) => readFileSync(join(spoolDir, name), 'utf8'))
    } catch {
      /* no spool */
    }
    return {
      code,
      timedOut,
      stdout,
      stderr,
      posts,
      spooled,
      descendantsRemain,
      elapsed: Date.now() - started
    }
  } finally {
    clearTimeout(timeout)
    child.stdin.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32')('Antigravity POSIX payload capture', () => {
  it('posts complete JSON without requiring EOF', async () => {
    const result = await runHook({ chunks: [PAYLOAD], close: false })
    expect(result).toMatchObject({
      code: 0,
      timedOut: false,
      descendantsRemain: false,
      stderr: '',
      posts: [PAYLOAD]
    })
  }, 10000)

  it.each([false, true])(
    'preserves delayed chunks (missing Python: %s)',
    async (noPython) => {
      const result = await runHook({
        chunks: [PAYLOAD.slice(0, 25), PAYLOAD.slice(25)],
        gapMs: 1500,
        close: true,
        noPython
      })
      expect(result).toMatchObject({
        code: 0,
        timedOut: false,
        descendantsRemain: false,
        stderr: '',
        posts: [PAYLOAD]
      })
    },
    10000
  )

  it.each([false, true])(
    'rejects incomplete input rather than posting it (missing Python: %s)',
    async (noPython) => {
      const result = await runHook({ chunks: ['{"unfinished":'], close: false, noPython })
      expect(result).toMatchObject({
        code: 0,
        timedOut: false,
        descendantsRemain: false,
        stderr: '',
        posts: [],
        spooled: []
      })
      expect(result.stdout.trim()).toBe('{"decision":""}')
    },
    10000
  )

  it.each([false, true])(
    'exits on abandoned stdin (missing Python: %s)',
    async (noPython) => {
      const result = await runHook({ chunks: [], close: false, noPython })
      expect(result).toMatchObject({
        code: 0,
        timedOut: false,
        descendantsRemain: false,
        stderr: ''
      })
    },
    10000
  )

  it('preserves offline event spooling', async () => {
    const result = await runHook({ chunks: [PAYLOAD], close: true, offline: true })
    expect(result).toMatchObject({
      code: 0,
      timedOut: false,
      descendantsRemain: false,
      stderr: '',
      posts: []
    })
    expect(result.spooled).toHaveLength(1)
    expect(JSON.parse(result.spooled[0])).toMatchObject({
      payload: JSON.parse(PAYLOAD),
      hookEventName: 'Stop'
    })
  }, 10000)
})
