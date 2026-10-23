import { describe, expect, it, vi } from 'vitest'
import { JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY } from '../../shared/jira-agent-capability'
import { RuntimeClientError } from '../runtime-client'
import { JIRA_WRITE_HANDLERS } from './jira-write'

function clientFailingWrite(failure: Error) {
  return vi.fn(async (method: string) => {
    if (method === 'status.get') {
      return { result: { capabilities: [JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY] } }
    }
    if (method === 'jira.status') {
      return { result: { sites: [{ id: 'site-1' }], selectedSiteId: 'site-1' } }
    }
    throw failure
  })
}

async function clearAssigneeAfter(failure: Error): Promise<unknown> {
  const handler = JIRA_WRITE_HANDLERS['jira assignee clear']
  try {
    await handler({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls client.call.
      client: { call: clientFailingWrite(failure) } as never,
      cwd: '/tmp',
      flags: new Map([['key', 'ORCA-1']]),
      json: false
    })
  } catch (error) {
    return error
  }
  throw new Error('expected the write to fail')
}

describe('Jira write outcome-unknown codes', () => {
  it.each([
    'runtime_timeout',
    'runtime_connection_failed',
    'runtime_disconnected',
    'runtime_unavailable'
  ])('reports %s as an unverified write', async (code) => {
    await expect(
      clearAssigneeAfter(new RuntimeClientError(code, 'failed.'))
    ).resolves.toMatchObject({ code: 'jira_write_unverified' })
  })

  it.each([
    'remote_runtime_unavailable',
    'runtime_manually_disconnected',
    'runtime_source_mismatch',
    'invalid_argument'
  ])('passes %s through unchanged', async (code) => {
    const failure = new RuntimeClientError(code, 'failed.')
    await expect(clearAssigneeAfter(failure)).resolves.toBe(failure)
  })

  it('passes a non-client error through unchanged', async () => {
    const failure = new Error('runtime_timeout')
    await expect(clearAssigneeAfter(failure)).resolves.toBe(failure)
  })
})
