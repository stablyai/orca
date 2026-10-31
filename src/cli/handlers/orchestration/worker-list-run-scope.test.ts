import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from '../orchestration'
import { okFixture } from '../../test-fixtures'

type Call = { name: string; params: Record<string, unknown> }

describe('orchestration worker-list Run scope (CLI handler)', () => {
  let calls: Call[]
  let logged: string[]
  let boundRun: string | null

  const client = {
    call: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params })
      if (name === 'orchestration.runCurrent') {
        return okFixture('req_current', { run: boundRun ? { id: boundRun } : null })
      }
      if (name === 'orchestration.workerList') {
        return okFixture('req_list', {
          workers: [],
          counts: {},
          page: { hasMore: false, nextCursor: null, total: 0 }
        })
      }
      throw new Error(`unexpected call ${name}`)
    }
  }

  beforeEach(() => {
    calls = []
    logged = []
    boundRun = null
    vi.stubEnv('ORCA_TERMINAL_HANDLE', undefined)
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
    vi.stubEnv('ORCA_STRUCTURED_SESSION', undefined)
    vi.stubEnv('ORCA_PANE_KEY', undefined)
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  async function list(flags = new Map<string, string | boolean>(), json = true) {
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags,
      client,
      cwd: '/tmp/repo',
      json
    } as never)
    expect(calls.map((call) => call.name)).toEqual(
      flags.has('run')
        ? ['orchestration.workerList']
        : ['orchestration.runCurrent', 'orchestration.workerList']
    )
    expect(logged).toHaveLength(1)
    const listCall = calls.find((call) => call.name === 'orchestration.workerList')
    const receipt: unknown = json ? JSON.parse(logged[0]) : null
    return { listCall, receipt }
  }

  it('defaults an unscoped list to the Run bound to the calling terminal', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    boundRun = 'run_bound'

    const { listCall, receipt } = await list()

    expect(calls[0]).toEqual({ name: 'orchestration.runCurrent', params: { from: 'term_coord' } })
    expect(listCall?.params.run).toBe('run_bound')
    expect(receipt).toHaveProperty('result.scope', { run: 'run_bound', source: 'bound' })
  })

  it('keeps --run as the override and never asks for the binding', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    boundRun = 'run_bound'

    const { listCall, receipt } = await list(new Map([['run', 'run_other']]))

    expect(calls.map((call) => call.name)).not.toContain('orchestration.runCurrent')
    expect(listCall?.params.run).toBe('run_other')
    expect(receipt).toHaveProperty('result.scope', { run: 'run_other', source: 'flag' })
  })

  it('still lists every Run when the caller has no bound Run', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_unbound_shell'
    boundRun = null

    const { listCall, receipt } = await list()

    expect(listCall?.params.run).toBeUndefined()
    expect(receipt).toHaveProperty('result.scope', { source: 'all' })
  })

  it('names the scope in the human-readable receipt', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    boundRun = 'run_bound'

    await list(new Map(), false)

    expect(logged.at(-1)).toContain('scope.run=run_bound scope.source=bound')
  })
})
