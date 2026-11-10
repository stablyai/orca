import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { nodeCloudCredentialFs } from './cloud-credentials'
import { createCloudHandlers } from './cloud-handlers'
import type { CloudHandlerDeps } from './cloud-operations'
import { createWorktreeOnCloud, type CloudOnDeps } from './worktree-create-on-cloud'

let home: string
let stdout: string[]
let stderr: string[]

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 })
  home = mkdtempSync(join(tmpdir(), 'orca-cloud-progress-'))
  stdout = []
  stderr = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void stdout.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void stderr.push(String(line)))
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk).trimEnd())
    return true
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

const workspace = (status: string) => ({
  id: 'sbx_ab12',
  name: 'child',
  status,
  origin: 'api',
  machineSize: 'standard',
  archived: false
})

/** A fetch that answers after `delayMs` of (fake) time. */
function slowFetch(delayMs: number, body: unknown, status = 200) {
  return vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        // ast-grep-ignore: test-no-real-time-wait -- fake timers drive this delay (vi.useFakeTimers in beforeEach)
        setTimeout(() => resolve(Response.json(body, { status })), delayMs)
      })
  )
}

function deps(fetchImpl: CloudHandlerDeps['fetch']): CloudOnDeps {
  return {
    env: { ORCA_CLOUD_TOKEN: 'orca_sk_x', ORCA_CLOUD_API_URL: 'https://cloud.test' },
    fetch: fetchImpl,
    fs: nodeCloudCredentialFs,
    home,
    now: () => Date.now(),
    sleep: async () => {},
    readStdin: async () => null,
    originUrl: () => null
  }
}

function ctx(flags: Record<string, string | boolean>, json = false): HandlerContext {
  return {
    flags: new Map(Object.entries(flags)),
    cwd: home,
    json,
    // Cloud commands must never reach the Orca runtime.
    get client(): never {
      throw new Error('cloud commands must not use the runtime client')
    }
  }
}

async function run<T>(promise: Promise<T>, advanceMs: number): Promise<T> {
  await vi.advanceTimersByTimeAsync(advanceMs)
  return promise
}

describe('orca cloud workspace wake progress', () => {
  it('says it is waking, then awake with the time it took', async () => {
    const handlers = createCloudHandlers(() =>
      deps(slowFetch(4800, { workspace: workspace('running'), state: 'running' }))
    )
    await run(handlers['cloud workspace wake'](ctx({ workspace: 'sbx_ab12' })), 5000)
    expect(stderr).toEqual(['- Waking sbx_ab12...', '- child is awake (took 4.8s).'])
    expect(stdout.join('\n')).toContain('status: running')
  })

  it('adds one reassurance line at 10 s', async () => {
    const handlers = createCloudHandlers(() =>
      deps(slowFetch(14_000, { workspace: workspace('running'), state: 'running' }))
    )
    await run(handlers['cloud workspace wake'](ctx({ workspace: 'sbx_ab12' })), 15_000)
    expect(stderr).toEqual([
      '- Waking sbx_ab12...',
      '- Still waking (10s). This is taking longer than usual; your files are safe.',
      '- child is awake (took 14.0s).'
    ])
  })

  it('exits 0 with status waking when the API is still waking after its wait', async () => {
    const handlers = createCloudHandlers(() =>
      deps(slowFetch(30_000, { workspace: workspace('sleeping'), state: 'waking' }))
    )
    await run(handlers['cloud workspace wake'](ctx({ workspace: 'sbx_ab12' }, true)), 31_000)
    expect(stderr).toEqual([]) // --json defaults progress to none
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: true,
      result: { state: 'waking', workspace: { status: 'waking' } }
    })

    stderr.length = 0
    await run(handlers['cloud workspace wake'](ctx({ workspace: 'sbx_ab12' })), 31_000)
    expect(stderr.at(-1)).toBe(
      '- child is still waking. Check with: orca cloud workspace show sbx_ab12'
    )
  })

  it('writes NDJSON phase events with --progress json and keeps stdout to the result', async () => {
    const handlers = createCloudHandlers(() =>
      deps(slowFetch(1000, { workspace: workspace('running'), state: 'running' }))
    )
    await run(
      handlers['cloud workspace wake'](ctx({ workspace: 'sbx_ab12', progress: 'json' }, true)),
      2000
    )
    expect(stderr.map((line) => JSON.parse(line).phase)).toEqual(['waking', 'awake'])
    expect(JSON.parse(stderr[1])).toMatchObject({
      event: 'phase',
      workspaceId: 'sbx_ab12',
      elapsedMs: 1000
    })
    expect(JSON.parse(stdout.join('')).ok).toBe(true)
  })

  it('shows sleep too', async () => {
    const handlers = createCloudHandlers(() =>
      deps(slowFetch(2000, { workspace: workspace('sleeping') }))
    )
    await run(handlers['cloud workspace sleep'](ctx({ workspace: 'sbx_ab12' })), 3000)
    expect(stderr).toEqual(['- Putting sbx_ab12 to sleep...', '- child is asleep (took 2.0s).'])
  })
})

describe('worktree create --on cloud progress', () => {
  it('prints a 10 s line and the elapsed time when the workspace is up', async () => {
    const created = slowFetch(12_000, { workspace: workspace('running') }, 201)
    await run(
      createWorktreeOnCloud(ctx({ on: 'cloud', name: 'child' }), () => deps(created)),
      13_000
    )
    expect(stderr).toEqual([
      '- Creating an Orca Cloud workspace...',
      '- Still starting (10s). This is taking longer than usual; your files are safe.',
      '- Workspace sbx_ab12 is running (took 12.0s).'
    ])
  })

  it('stays quiet before 10 s', async () => {
    const created = slowFetch(6000, { workspace: workspace('running') }, 201)
    await run(
      createWorktreeOnCloud(ctx({ on: 'cloud', name: 'child' }), () => deps(created)),
      7000
    )
    expect(stderr).toEqual([
      '- Creating an Orca Cloud workspace...',
      '- Workspace sbx_ab12 is running (took 6.0s).'
    ])
  })
})
