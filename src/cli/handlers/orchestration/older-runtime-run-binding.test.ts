import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from '../orchestration'
import { RuntimeClient, RuntimeClientError } from '../../runtime-client'
import { okFixture } from '../../test-fixtures'

const client = new RuntimeClient('/tmp/orca-older-runtime-run', 60_000, null, null)

describe('an older Orca server that binds one Run per coordinator', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_CLI_COMMAND', 'orca')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
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
})
