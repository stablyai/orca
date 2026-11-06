import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, validateCommandAndFlags } from '../args'
import { dispatch } from '../dispatch'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import { CORE_COMMAND_SPECS } from '../specs/core'

const client = new RuntimeClient('/tmp/orca-branch-transport-test', 10_000, null, null)

function run() {
  const parsed = parseArgs([
    'repo',
    'delete-branch',
    '--repo',
    'id:repo-1',
    '--repo-host-id',
    'local',
    '--ref',
    'refs/heads/feature',
    '--expected-oid',
    '1111111111111111111111111111111111111111',
    '--anchor-ref',
    'refs/remotes/origin/main',
    '--anchor-oid',
    '2222222222222222222222222222222222222222',
    '--json'
  ])
  validateCommandAndFlags(CORE_COMMAND_SPECS, parsed)
  return dispatch(parsed.commandPath, { flags: parsed.flags, client, cwd: '/tmp', json: true })
}

afterEach(() => vi.restoreAllMocks())

describe('standalone branch deletion paired transport loss', () => {
  it('requires fresh inventory when the paired transport closes after dispatch', async () => {
    vi.spyOn(client, 'call').mockImplementation(async (_method, _params, options) => {
      options?.requestSelection?.paramsForStatus({ capabilities: ['repo.delete-branch.v1'] })
      options?.requestSelection?.onDispatch?.()
      throw new RuntimeClientError(
        'remote_runtime_unavailable',
        'Remote Orca runtime closed the connection.',
        { closeCode: 1006 }
      )
    })
    await expect(run()).rejects.toMatchObject({
      code: 'branch_deletion_uncertain',
      data: { effect: 'unknown', restoration: 'not-attempted', inventoryRequired: true }
    })
  })

  it('preserves the paired transport refusal before any mutation dispatch', async () => {
    const failure = new RuntimeClientError(
      'remote_runtime_unavailable',
      'Remote Orca runtime closed the connection.',
      { closeCode: 1006 }
    )
    vi.spyOn(client, 'call').mockRejectedValue(failure)
    await expect(run()).rejects.toBe(failure)
  })
})
