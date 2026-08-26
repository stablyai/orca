import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { liveSqliteUnavailableIssue, sessionParseIssueFromError } from './session-scan-issues'

describe('sessionParseIssueFromError', () => {
  it('maps a locked provider database to a retryable notice, not a raw sqlite string', () => {
    expect(
      sessionParseIssueFromError({
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        agent: 'opencode',
        path: '/tmp/opencode.db',
        error: new Error('database is locked')
      })
    ).toEqual(
      liveSqliteUnavailableIssue({
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        agent: 'opencode',
        path: '/tmp/opencode.db'
      })
    )
  })

  it('keeps non-lock parse failures as skipped-transcript issues', () => {
    expect(
      sessionParseIssueFromError({
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        agent: 'opencode',
        path: '/tmp/opencode.db',
        error: new Error('no such table: session')
      })
    ).toEqual({
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      agent: 'opencode',
      path: '/tmp/opencode.db',
      message: 'no such table: session'
    })
  })
})
