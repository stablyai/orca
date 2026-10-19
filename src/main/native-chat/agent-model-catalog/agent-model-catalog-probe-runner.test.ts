import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentModelCatalogProbeError,
  runAgentModelCatalogListing,
  runAgentModelCatalogSession
} from './agent-model-catalog-probe-runner'

// Every child here is this test's own Node, never an agent CLI.
const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true })
  }
})

function node(script: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', script] }
}

function pidFile(): string {
  const folder = mkdtempSync(join(tmpdir(), 'orca-catalog-probe-'))
  folders.push(folder)
  return join(folder, 'pid')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' }

describe('the shared catalog probe runner', () => {
  it('answers a listing’s stdout once it exits 0, with its request on stdin', async () => {
    const stdout = await runAgentModelCatalogListing(
      {
        ...node(
          "let i='';process.stdin.on('data',c=>i+=c);process.stdin.on('end',()=>process.stdout.write('got:'+i))"
        ),
        env: NODE_ENV,
        stdin: 'list'
      },
      { site: 'test-listing' }
    )
    expect(stdout).toBe('got:list')
  })

  it('rejects a listing that exits non-zero, with its stderr', async () => {
    await expect(
      runAgentModelCatalogListing(
        { ...node("process.stderr.write('not signed in');process.exit(3)"), env: NODE_ENV },
        { site: 'test-listing' }
      )
    ).rejects.toMatchObject({ reason: 'exit', message: expect.stringContaining('not signed in') })
  })

  it('stops a listing that outlives its budget before rejecting', async () => {
    const file = pidFile()
    const run = runAgentModelCatalogListing(
      {
        ...node(
          `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid));setInterval(()=>{},1000)`
        ),
        env: NODE_ENV
      },
      { site: 'test-listing', timeoutMs: 1_000 }
    )
    await expect(run).rejects.toMatchObject({ reason: 'timeout' })
    const pid = Number(readFileSync(file, 'utf8'))
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5_000 })
  }, 20_000)

  it('stops a running listing, and starts none, once its host stops it', async () => {
    const file = pidFile()
    const stop = new AbortController()
    const run = runAgentModelCatalogListing(
      {
        ...node(
          `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid));setInterval(()=>{},1000)`
        ),
        env: NODE_ENV
      },
      { site: 'test-listing', signal: stop.signal }
    )
    await vi.waitFor(() => expect(readFileSync(file, 'utf8')).not.toBe(''), { timeout: 5_000 })
    stop.abort()
    await expect(run).rejects.toMatchObject({ reason: 'stopped' })
    const pid = Number(readFileSync(file, 'utf8'))
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5_000 })

    const never = pidFile()
    await expect(
      runAgentModelCatalogListing(
        { ...node(`require('fs').writeFileSync(${JSON.stringify(never)}, 'ran')`), env: NODE_ENV },
        { site: 'test-listing', signal: stop.signal }
      )
    ).rejects.toMatchObject({ reason: 'stopped' })
    expect(() => readFileSync(never, 'utf8')).toThrow()
  }, 20_000)

  it('stops a listing whose output overflows the cap', async () => {
    const file = pidFile()
    const run = runAgentModelCatalogListing(
      {
        ...node(
          `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid));setInterval(()=>process.stdout.write('x'.repeat(4096)),5)`
        ),
        env: NODE_ENV
      },
      { site: 'test-listing', maxOutputBytes: 64 * 1024 }
    )
    await expect(run).rejects.toMatchObject({ reason: 'output-overflow' })
    const pid = Number(readFileSync(file, 'utf8'))
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5_000 })
  }, 20_000)

  it('rejects a command that cannot start, saying its executable is missing', async () => {
    const failure = await runAgentModelCatalogListing(
      { command: join(tmpdir(), 'orca-no-such-agent-binary'), args: [] },
      { site: 'test-listing' }
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AgentModelCatalogProbeError)
    expect(failure).toMatchObject({ reason: 'spawn', executableMissing: true })
  })

  it('closes a probe connection on success, failure and timeout alike', async () => {
    const closes: string[] = []
    const open = (name: string) => () => ({
      close: async () => {
        closes.push(name)
      }
    })
    await expect(
      runAgentModelCatalogSession(open('ok'), async () => 1, { label: 'a' })
    ).resolves.toBe(1)
    await expect(
      runAgentModelCatalogSession(
        open('crash'),
        async () => {
          throw new Error('agent exited')
        },
        { label: 'a' }
      )
    ).rejects.toThrow('agent exited')
    await expect(
      runAgentModelCatalogSession(open('hang'), () => new Promise(() => {}), {
        label: 'a',
        timeoutMs: 20
      })
    ).rejects.toMatchObject({ reason: 'timeout' })
    const stop = new AbortController()
    const stopped = runAgentModelCatalogSession(open('stopped'), () => new Promise(() => {}), {
      label: 'a',
      signal: stop.signal
    })
    stop.abort()
    await expect(stopped).rejects.toMatchObject({ reason: 'stopped' })
    expect(closes).toEqual(['ok', 'crash', 'hang', 'stopped'])
  })
})
