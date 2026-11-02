import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from '../orchestration'
import { RuntimeClient, RuntimeClientError } from '../../runtime-client'
import { okFixture } from '../../test-fixtures'

const client = new RuntimeClient('/tmp/orca-older-runtime-run', 60_000, null, null)

describe('an older Orca server that binds one Run per coordinator', () => {
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubEnv('ORCA_CLI_COMMAND', 'orca')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('tells worker-start to create a Run first instead of creating one itself', async () => {
    const methods: string[] = []
    vi.spyOn(client, 'call').mockImplementation(async (method: string) => {
      methods.push(method)
      if (method === 'status.get') {
        return okFixture('req_status', { capabilities: [] })
      }
      throw new RuntimeClientError('run_required', 'No Run is bound.')
    })

    await expect(
      ORCHESTRATION_HANDLERS['orchestration worker-start']({
        flags: new Map<string, string | boolean>([
          ['full', true],
          ['spec', 'audit'],
          ['from', 'term_coord']
        ]),
        client,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message:
        'This Orca server is an older version and needs a Run first. Run `orca orchestration run-create --objective "<goal>" --json`, then run this worker-start again.'
    })
    expect(methods).not.toContain('orchestration.runCreate')
  })

  it('names the Run that run-create unbound and how to switch back', async () => {
    vi.spyOn(client, 'call').mockImplementation(async (method: string) => {
      if (method === 'status.get') {
        return okFixture('req_status', { capabilities: [] })
      }
      if (method === 'orchestration.runCurrent') {
        return okFixture('req_current', { run: { id: 'run_a', objective: 'first' } })
      }
      if (method === 'orchestration.runCreate') {
        return okFixture('req_create', {
          run: { id: 'run_b', objective: 'second', consumer_generation: 1 }
        })
      }
      throw new Error(`Unexpected RPC: ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration run-create']({
      flags: new Map<string, string | boolean>([
        ['full', true],
        ['objective', 'second'],
        ['from', 'term_coord']
      ]),
      client,
      cwd: '/tmp',
      json: true
    })

    expect(JSON.parse(String(log.mock.calls[0][0])).result).toMatchObject({
      run: { id: 'run_b' },
      next: 'This Orca server is an older version and keeps one Run per coordinator; run_a is no longer bound to you. Switch back with `orca orchestration run-use --id run_a --json`.'
    })
  })
})
