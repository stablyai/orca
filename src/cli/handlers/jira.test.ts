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
import { okFixture, queueFixtures } from '../test-fixtures'

function transitions(): unknown {
  return [
    { id: '21', name: 'Start Progress', to: { id: '3', name: 'In Progress' } },
    { id: '31', name: 'Ready for Review', to: { id: '4', name: 'In Review' } }
  ]
}

describe('orca jira CLI handlers', () => {
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

  it('reads a single issue by key', async () => {
    queueFixtures(callMock, okFixture('req_issue', { key: 'ENG-1' }))

    await main(['jira', 'issue', 'ENG-1', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('jira.getIssue', { key: 'ENG-1', siteId: undefined })
  })

  it('passes JQL and limit through to search', async () => {
    queueFixtures(callMock, okFixture('req_search', []))

    await main(
      ['jira', 'search', 'project = ENG AND status = Done', '--limit', '5', '--site', 'site-1'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('jira.searchIssues', {
      jql: 'project = ENG AND status = Done',
      limit: 5,
      siteId: 'site-1'
    })
  })

  it('rejects an unknown list filter before dispatch', async () => {
    await main(['jira', 'list', '--filter', 'nope'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('--filter must be one of')
    expect(process.exitCode).toBe(1)
  })

  it('resolves --to against transition names before updating', async () => {
    queueFixtures(
      callMock,
      okFixture('req_transitions', transitions()),
      okFixture('req_update', { ok: true })
    )

    await main(['jira', 'status', 'set', 'ENG-1', '--to', 'Ready for Review'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(1, 'jira.listTransitions', {
      key: 'ENG-1',
      siteId: undefined
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'jira.updateIssue', {
      key: 'ENG-1',
      siteId: undefined,
      updates: { transitionId: '31' }
    })
  })

  it('resolves --to against the destination status name', async () => {
    queueFixtures(
      callMock,
      okFixture('req_transitions', transitions()),
      okFixture('req_update', { ok: true })
    )

    await main(['jira', 'status', 'set', 'ENG-1', '--to', 'in progress'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(2, 'jira.updateIssue', {
      key: 'ENG-1',
      siteId: undefined,
      updates: { transitionId: '21' }
    })
  })

  it('lists the available transitions when --to matches none', async () => {
    queueFixtures(callMock, okFixture('req_transitions', transitions()))

    await main(['jira', 'status', 'set', 'ENG-1', '--to', 'Shipped'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'No transition matching "Shipped". Available: Start Progress, Ready for Review'
    )
    expect(process.exitCode).toBe(1)
  })

  // Why: a transition name can collide with another transition's destination
  // status, and silently taking the first match would move the issue somewhere
  // the caller never named.
  it('refuses an ambiguous --to instead of taking the first match', async () => {
    queueFixtures(
      callMock,
      okFixture('req_transitions', [
        { id: '21', name: 'In Review', to: { id: '3', name: 'Reviewing' } },
        { id: '31', name: 'Send Back', to: { id: '4', name: 'In Review' } }
      ])
    )

    await main(['jira', 'status', 'set', 'ENG-1', '--to', 'In Review'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Ambiguous transition "In Review". Retry with --to-id: 21 (In Review → Reviewing), 31 (Send Back → In Review)'
    )
    expect(process.exitCode).toBe(1)
  })

  it('skips the transition lookup when --to-id is given', async () => {
    queueFixtures(callMock, okFixture('req_update', { ok: true }))

    await main(['jira', 'status', 'set', 'ENG-1', '--to-id', '31'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('jira.updateIssue', {
      key: 'ENG-1',
      siteId: undefined,
      updates: { transitionId: '31' }
    })
  })

  it('clears an assignee with an explicit null', async () => {
    queueFixtures(callMock, okFixture('req_update', { ok: true }))

    await main(['jira', 'assignee', 'clear', 'ENG-1'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('jira.updateIssue', {
      key: 'ENG-1',
      siteId: undefined,
      updates: { assigneeAccountId: null }
    })
  })

  it('replaces labels from repeated --label flags', async () => {
    queueFixtures(callMock, okFixture('req_update', { ok: true }))

    await main(
      ['jira', 'label', 'set', 'ENG-1', '--label', 'backend', '--label', 'p1'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('jira.updateIssue', {
      key: 'ENG-1',
      siteId: undefined,
      updates: { labels: ['backend', 'p1'] }
    })
  })

  // Why: label set is a full replacement, so a missing --label would silently
  // wipe every label on the issue instead of updating nothing.
  it('refuses label set without at least one --label', async () => {
    await main(['jira', 'label', 'set', 'ENG-1'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('--label is required')
    expect(process.exitCode).toBe(1)
  })

  // Why: Jira reports write failures in a 200 body, so an ok:false result has to
  // become a CLI error instead of printing a success line.
  it('surfaces an ok:false mutation body as a CLI failure', async () => {
    queueFixtures(callMock, okFixture('req_update', { ok: false, error: 'Field is required' }))

    await main(['jira', 'priority', 'set', 'ENG-1', '--to-id', '2'], '/tmp/repo')

    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Field is required')
    expect(process.exitCode).toBe(1)
  })

  it('prints the created key and URL on success', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        ok: true,
        id: '10042',
        key: 'ENG-9',
        url: 'https://example.atlassian.net/browse/ENG-9'
      })
    )

    await main(
      ['jira', 'create', '--project', 'ENG', '--type', '10001', '--title', 'Broken login'],
      '/tmp/repo'
    )

    expect(vi.mocked(console.log).mock.calls[0][0]).toBe(
      'Created ENG-9\nURL: https://example.atlassian.net/browse/ENG-9'
    )
    expect(process.exitCode).toBeUndefined()
  })

  it('surfaces an ok:false create body as a CLI failure', async () => {
    queueFixtures(callMock, okFixture('req_create', { ok: false, error: 'Project not found' }))

    await main(
      ['jira', 'create', '--project', 'ENG', '--type', '10001', '--title', 'Broken login'],
      '/tmp/repo'
    )

    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Project not found')
    expect(process.exitCode).toBe(1)
  })
})
