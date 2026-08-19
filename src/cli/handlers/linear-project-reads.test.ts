import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', async () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode = process.env.ORCA_PAIRING_CODE ?? null,
      environmentSelector = process.env.ORCA_ENVIRONMENT ?? null
    ) {
      this.isRemote = Boolean(remotePairingCode || environmentSelector)
    }
  }

  // Why: re-export the REAL error classes; format.ts narrows with `instanceof`
  // against ./runtime/types, so a look-alike would collapse every CLI error
  // code into the generic `runtime_error` shape.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')

  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { main } from '../index'
import { RuntimeRpcFailureError } from '../runtime/types'
import { okFixture, queueFixtures } from '../test-fixtures'

function showResult(): unknown {
  return {
    project: {
      id: 'project-1',
      name: 'Launch Q3',
      slugId: 'launch-q3',
      url: 'https://linear.app/acme/project/launch-q3-1a2b3c',
      description: { value: 'Ship it', truncated: false, chars: 7, sha256: 'a'.repeat(64) },
      content: { value: null, truncated: false, chars: 0, sha256: '' },
      status: { id: 'status-1', name: 'In Progress', type: 'started', color: '#00ff00' },
      lead: null,
      members: { items: [], returned: 0, total: 0, truncated: false, sha256: 'b'.repeat(64) },
      teams: { items: [], returned: 0, total: 0, truncated: false, sha256: 'c'.repeat(64) },
      labels: { items: [], returned: 0, total: 0, truncated: false, sha256: 'd'.repeat(64) },
      priority: 0,
      startDate: null,
      targetDate: null,
      color: '#123456',
      icon: null,
      health: null,
      healthUpdatedAt: null
    },
    meta: { workspaceId: 'workspace-1', workspaceName: 'Acme', resolvedBy: 'slug' }
  }
}

function metadataResult(key: 'statuses' | 'labels'): unknown {
  return {
    [key]: [],
    meta: {
      limit: 20,
      returned: 0,
      partial: false,
      workspaceResults: [],
      workspaceErrors: []
    }
  }
}

describe('orca linear project read handlers', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.env = { ...originalEnv }
    delete process.env.ORCA_WORKTREE_ID
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PAIRING_CODE
    delete process.env.ORCA_ENVIRONMENT
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('maps a positional project target to agentProjectShow without update bodies', async () => {
    queueFixtures(callMock, okFixture('req_show', showResult()))

    await main(['linear', 'project', 'show', 'launch-q3', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('linear.agentProjectShow', {
      input: 'launch-q3',
      workspaceId: undefined,
      updates: false
    })
    const printed = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0])) as {
      ok: boolean
      result: { project: { slugId: string } }
    }
    expect(printed.ok).toBe(true)
    expect(printed.result.project.slugId).toBe('launch-q3')
  })

  it('sends --id, --workspace and a clamped --updates-limit', async () => {
    queueFixtures(callMock, okFixture('req_show', showResult()))

    await main(
      [
        'linear',
        'project',
        'show',
        '--id',
        'launch-q3',
        '--workspace',
        'workspace-1',
        '--updates',
        '--updates-limit',
        '99',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('linear.agentProjectShow', {
      input: 'launch-q3',
      workspaceId: 'workspace-1',
      updates: true,
      updatesLimit: 25
    })
  })

  it('rejects --workspace all for project show without issuing an RPC', async () => {
    await main(['linear', 'project', 'show', 'launch-q3', '--workspace', 'all'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain(
      '--workspace all is not valid for a single Linear project'
    )
  })

  it('reports linear_invalid_workspace in --json for --workspace all', async () => {
    await main(
      ['linear', 'project', 'show', 'launch-q3', '--workspace', 'all', '--json'],
      '/tmp/repo'
    )

    const printed = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0])) as {
      error: { code: string }
    }
    expect(printed.error.code).toBe('linear_invalid_workspace')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects --updates-limit without --updates before any RPC', async () => {
    await main(['linear', 'project', 'show', 'launch-q3', '--updates-limit', '5'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain(
      '--updates-limit requires --updates'
    )
  })

  it('rejects a non-positive --updates-limit', async () => {
    await main(
      ['linear', 'project', 'show', 'launch-q3', '--updates', '--updates-limit', '0'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain(
      'Invalid positive integer for --updates-limit'
    )
  })

  it('rejects a project passed both positionally and as --id', async () => {
    await main(['linear', 'project', 'show', 'launch-q3', '--id', 'other'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain(
      'Pass --id either positionally or as a flag, not both.'
    )
  })

  it('requires a project target', async () => {
    await main(['linear', 'project', 'show'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain(
      'Pass a Linear project UUID, slugId, URL, or exact name'
    )
  })

  it('maps project statuses to agentProjectStatuses with a clamped limit', async () => {
    queueFixtures(callMock, okFixture('req_statuses', metadataResult('statuses')))

    await main(
      ['linear', 'project', 'statuses', '--query', 'prog', '--limit', '500', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('linear.agentProjectStatuses', {
      query: 'prog',
      limit: 50,
      workspaceId: undefined
    })
  })

  it('maps project labels to agentProjectLabels and allows --workspace all', async () => {
    queueFixtures(callMock, okFixture('req_labels', metadataResult('labels')))

    await main(['linear', 'project', 'labels', '--workspace', 'all', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('linear.agentProjectLabels', {
      query: undefined,
      limit: 20,
      workspaceId: 'all'
    })
  })

  it('defaults the metadata limit when --limit is omitted', async () => {
    queueFixtures(callMock, okFixture('req_statuses', metadataResult('statuses')))

    await main(['linear', 'project', 'statuses'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('linear.agentProjectStatuses', {
      query: undefined,
      limit: 20,
      workspaceId: undefined
    })
  })

  it('rewrites method_not_found into an upgrade instruction in human mode', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_show',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method linear.agentProjectShow' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )

    await main(['linear', 'project', 'show', 'launch-q3'], '/tmp/repo')

    const stderr = String(vi.mocked(console.error).mock.calls[0][0])
    expect(stderr).toContain('This Orca host does not support `orca linear project show`.')
    expect(stderr).toContain('Update the remote Orca host and retry.')
    expect(stderr).toContain('its success does not imply project-write support.')
    expect(stderr).not.toContain('method_not_found')
    expect(process.exitCode).toBe(1)
  })

  it('never leaks the raw method_not_found code in --json mode', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_labels',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method linear.agentProjectLabels' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )

    await main(['linear', 'project', 'labels', '--json'], '/tmp/repo')

    const printed = String(vi.mocked(console.log).mock.calls[0][0])
    expect(printed).not.toContain('method_not_found')
    const parsed = JSON.parse(printed) as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('unsupported_host')
    expect(parsed.error.message).toContain('orca linear project labels')
  })

  it('passes through an unrelated RPC failure untouched', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_show',
        ok: false,
        error: { code: 'linear_invalid_project', message: 'Ambiguous project target' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )

    await main(['linear', 'project', 'show', 'launch-q3', '--json'], '/tmp/repo')

    const parsed = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0])) as {
      error: { code: string }
    }
    expect(parsed.error.code).toBe('linear_invalid_project')
  })

  it('prints fan-out warnings only in human mode', async () => {
    const partial = {
      statuses: [],
      meta: {
        limit: 20,
        returned: 0,
        partial: true,
        workspaceResults: [
          { workspace: { id: 'workspace-1', name: 'Acme' }, returned: 0, hasMore: true }
        ],
        workspaceErrors: [
          {
            workspace: { id: 'workspace-2', name: 'Globex' },
            code: 'linear_rate_limited',
            message: 'Rate limited'
          }
        ]
      }
    }
    queueFixtures(callMock, okFixture('req_statuses', partial), okFixture('req_statuses', partial))

    await main(['linear', 'project', 'statuses'], '/tmp/repo')
    const humanWarnings = vi.mocked(console.error).mock.calls.map((call) => String(call[0]))
    expect(humanWarnings.join('\n')).toContain('Globex unavailable for Linear project statuses')

    vi.mocked(console.error).mockClear()
    await main(['linear', 'project', 'statuses', '--json'], '/tmp/repo')
    expect(console.error).not.toHaveBeenCalled()
  })
})
