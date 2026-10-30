import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from '../orchestration'
import { RuntimeClient } from '../../runtime-client'
import { okFixture } from '../../test-fixtures'

const client = new RuntimeClient('/tmp/orca-implicit-coordinator', 60_000, null, null)
const COORDINATOR_WORKTREE = { id: 'repo::/tmp/coord', repoId: 'repo', path: '/tmp/coord' }

describe('worker-start infers its coordinator from the caller, not the worker placement (#33579)', () => {
  const calls: { method: string; params: unknown }[] = []

  beforeEach(() => {
    calls.length = 0
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
    vi.stubEnv('ORCA_STRUCTURED_SESSION', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(client, 'call').mockImplementation(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'worktree.list') {
        return okFixture('req_list', { worktrees: [COORDINATOR_WORKTREE] })
      }
      if (method === 'terminal.resolveActive') {
        const worktree =
          params && typeof params === 'object' && 'worktree' in params ? params.worktree : undefined
        if (worktree !== `id:${COORDINATOR_WORKTREE.id}`) {
          throw Object.assign(new Error('selector_not_found'), { code: 'selector_not_found' })
        }
        return okFixture('req_active', { handle: 'term_coord' })
      }
      if (method === 'orchestration.workerStart') {
        return okFixture('req_start', { state: 'ready', effects: [], residualResources: [] })
      }
      throw new Error(`Unexpected RPC: ${method}`)
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  const placements: [string, Record<string, string>][] = [
    ['an exact worktree on another server', { on: 'wsl', worktree: 'id:remote::/srv/app' }],
    ['a new child worktree', { worktree: 'new-child' }],
    ['a reused worker terminal', { worktree: 'id:repo::/tmp/other', terminal: 'term_worker' }]
  ]

  it.each(placements)('for %s', async (_label, placement) => {
    await ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags: new Map<string, string | boolean>([['spec', 'audit'], ...Object.entries(placement)]),
      client,
      cwd: '/tmp/coord/src',
      json: true
    })

    expect(calls.find((call) => call.method === 'orchestration.workerStart')?.params).toMatchObject(
      { from: 'term_coord', ...placement }
    )
  })
})
