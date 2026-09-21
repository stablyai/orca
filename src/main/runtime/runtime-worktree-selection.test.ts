import { describe, expect, it } from 'vitest'
import { runtimeRepoMatchesExecutionHost } from './runtime-worktree-selection'

describe('runtimeRepoMatchesExecutionHost', () => {
  it('matches an unstamped SSH repo against its own host (#11163)', () => {
    // The row spells its ownership as `connectionId`; the request spells it as `ssh:<target>`.
    // Rejecting it here makes repo-add/clone dedupe register a second row for the same path.
    expect(runtimeRepoMatchesExecutionHost({ connectionId: 'target-1' }, 'ssh:target-1')).toBe(true)
  })

  it('matches a stamped SSH repo against its own host', () => {
    expect(
      runtimeRepoMatchesExecutionHost(
        { connectionId: 'target-1', executionHostId: 'ssh:target-1' },
        'ssh:target-1'
      )
    ).toBe(true)
  })

  it('rejects an unstamped SSH repo against a different SSH host', () => {
    expect(runtimeRepoMatchesExecutionHost({ connectionId: 'target-1' }, 'ssh:target-2')).toBe(
      false
    )
  })

  it('rejects an unstamped SSH repo against local and runtime hosts', () => {
    expect(runtimeRepoMatchesExecutionHost({ connectionId: 'target-1' }, 'local')).toBe(false)
    expect(runtimeRepoMatchesExecutionHost({ connectionId: 'target-1' }, 'runtime:env-1')).toBe(
      false
    )
  })

  it('keeps a host-less legacy repo adoptable by any host', () => {
    expect(runtimeRepoMatchesExecutionHost({}, 'runtime:env-1')).toBe(true)
    expect(runtimeRepoMatchesExecutionHost({}, 'local')).toBe(true)
    expect(runtimeRepoMatchesExecutionHost({}, 'ssh:target-1')).toBe(true)
  })

  it('matches any repo when the caller names no host', () => {
    expect(runtimeRepoMatchesExecutionHost({ connectionId: 'target-1' })).toBe(true)
    expect(runtimeRepoMatchesExecutionHost({ executionHostId: 'runtime:env-1' }, null)).toBe(true)
  })

  it('keeps a stamped repo bound to the host it names', () => {
    expect(runtimeRepoMatchesExecutionHost({ executionHostId: 'runtime:env-1' }, 'local')).toBe(
      false
    )
    expect(
      runtimeRepoMatchesExecutionHost(
        { executionHostId: 'local', connectionId: 'target-1' },
        'local'
      )
    ).toBe(true)
  })
})
