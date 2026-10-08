import { describe, expect, it } from 'vitest'
import {
  getRuntimeWorktreeRemovalOptionsKey,
  runtimeRepoMatchesExecutionHost
} from './runtime-worktree-selection'

describe('getRuntimeWorktreeRemovalOptionsKey', () => {
  it('separates a waived archive-hook retry from the attempt about to refuse on it (#19334)', () => {
    const strict = getRuntimeWorktreeRemovalOptionsKey({ runHooks: true })
    expect(
      getRuntimeWorktreeRemovalOptionsKey({ runHooks: true, allowFailedArchiveHook: true })
    ).not.toBe(strict)
  })

  it('keeps every waiver on its own axis, so none of them coalesce', () => {
    const keys = [
      {},
      { force: true },
      { runHooks: true },
      { allowUnverifiedPtyStop: true },
      { allowFailedArchiveHook: true }
    ].map(getRuntimeWorktreeRemovalOptionsKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('treats an omitted option as its off value', () => {
    expect(getRuntimeWorktreeRemovalOptionsKey({})).toBe(
      getRuntimeWorktreeRemovalOptionsKey({
        force: false,
        runHooks: false,
        allowUnverifiedPtyStop: false,
        allowFailedArchiveHook: false
      })
    )
  })
})

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
