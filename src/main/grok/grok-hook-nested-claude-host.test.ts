import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getGrokManagedScript } from './grok-hook-script'
import { buildWindowsGrokHookScript } from './windows-grok-hook-script'

// Why (#20109): Claude launching Grok as a nested CLI leaves Grok holding the
// lead pane's ORCA_PANE_KEY, so a nested Stop would settle the Claude pane and
// fire Agent Task Complete mid-turn. Run the real generated script rather than
// asserting on its text: the guard only matters if /bin/sh actually takes it.
describe.skipIf(process.platform === 'win32')('Grok POSIX hook under a Claude host', () => {
  let dir = ''
  let server: Server | null = null

  afterEach(async () => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = ''
    }
    if (server) {
      const closing = server
      server = null
      await new Promise<void>((resolve) => closing.close(() => resolve()))
    }
  })

  /** Runs the managed script against a local endpoint and reports what it posted. */
  async function runHook(env: Record<string, string>): Promise<{
    exitCode: number | null
    posts: string[]
    spoolFiles: string[]
  }> {
    dir = mkdtempSync(join(tmpdir(), 'orca-grok-nested-'))
    const scriptPath = join(dir, 'grok-hook.sh')
    writeFileSync(scriptPath, getGrokManagedScript('posix'), { mode: 0o755 })

    const posts: string[] = []
    server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      request.on('end', () => {
        posts.push(body)
        response.writeHead(200).end('ok')
      })
    })
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })

    // Why: a readable endpoint file is what lets spool_hook_event write at all.
    // With it unset the spool assertion below would pass even if a nested run
    // spooled, because the helper returns before touching the disk.
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, '')

    const child = spawn('/bin/sh', [scriptPath], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        ORCA_PANE_KEY: 'pane-lead',
        ORCA_AGENT_HOOK_PORT: String(port),
        ORCA_AGENT_HOOK_TOKEN: 'token-1',
        ORCA_AGENT_HOOK_ENDPOINT: endpointPath,
        ...env
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'nested-1' }))

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('grok hook did not exit within 10s'))
      }, 10_000)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })

    // The spool is the other way an event could still reach the lead pane.
    // spool_hook_event derives its directory from the endpoint file's own
    // parent (`${ORCA_AGENT_HOOK_ENDPOINT%/*}/spool`), not from HOME.
    const spoolRoot = join(dir, 'spool')
    let spoolFiles: string[] = []
    try {
      const { readdirSync } = await import('node:fs')
      spoolFiles = readdirSync(spoolRoot, { recursive: true, encoding: 'utf8' }).filter((entry) =>
        entry.endsWith('.jsonl')
      )
    } catch {
      spoolFiles = []
    }

    return { exitCode, posts, spoolFiles }
  }

  it('posts a native run to the pane it belongs to', async () => {
    const result = await runHook({})

    expect(result.exitCode).toBe(0)
    expect(result.posts).toHaveLength(1)
    expect(result.posts[0]).toContain('paneKey=pane-lead')
  })

  // Why: without this the "spools nothing" assertions below would be vacuous —
  // they must be able to observe a spool file when one is genuinely written.
  it('spools a native run whose post cannot be delivered', async () => {
    const result = await runHook({ ORCA_AGENT_HOOK_PORT: '1' })

    expect(result.exitCode).toBe(0)
    expect(result.posts).toEqual([])
    expect(result.spoolFiles.length).toBeGreaterThan(0)
  })

  it.each(['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_JOB_DIR'])(
    'posts nothing and spools nothing when %s marks a nested run',
    async (variable) => {
      const result = await runHook({ [variable]: '1' })

      expect(result.exitCode).toBe(0)
      expect(result.posts).toEqual([])
      expect(result.spoolFiles).toEqual([])
    }
  )
})

describe('Windows grok hook under a Claude host', () => {
  // Why: cmd cannot run here, so pin the ordering the drain contract needs.
  it('routes a nested turn to the stdin drain instead of posting', () => {
    const lines = buildWindowsGrokHookScript().split('\r\n')
    const postIndex = lines.findIndex((line) => line.includes('/hook/grok'))
    expect(postIndex).toBeGreaterThan(-1)

    for (const variable of ['CLAUDECODE', 'CLAUDE_CODE']) {
      const guardIndex = lines.findIndex(
        (line) =>
          line.includes(`%${variable}%`) && line.includes('goto :orca_agent_hook_drain_stdin')
      )
      expect(guardIndex, `${variable} guard missing`).toBeGreaterThan(-1)
      expect(guardIndex).toBeLessThan(postIndex)
    }
  })

  // Why: a backgrounded Claude job is the abandoned-stdin case #11549 guards
  // against, so it must exit rather than park in more.com. claude-hook.cmd is
  // pinned to the same shape in claude/hook-service.test.ts.
  it('exits on the daemon-worker marker without routing to the drain', () => {
    const lines = buildWindowsGrokHookScript().split('\r\n')
    const guard = lines.find((line) => line.includes('%CLAUDE_JOB_DIR%'))

    expect(guard).toBe('if not "%CLAUDE_JOB_DIR%"=="" exit /b 0')
    expect(guard).not.toContain('orca_agent_hook_drain_stdin')
  })
})
