import { describe, expect, it } from 'vitest'
import { remoteCliRequestTimeoutMs } from './remote-cli-timeout'

describe('remoteCliRequestTimeoutMs', () => {
  it('gives Linear issue context reads the general CLI budget', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['linear', 'issue', 'ENG-123', '--json']
      })
    ).toBe(300_000)
  })

  it('gives ordinary remote CLI requests the general CLI budget instead of the 30s relay default', () => {
    // Why: mutation commands bridged through the full host CLI (worktree
    // create, orchestration dispatch, ...) can legitimately exceed 30s.
    expect(remoteCliRequestTimeoutMs({ argv: ['status'] })).toBe(300_000)
    expect(remoteCliRequestTimeoutMs({ argv: ['worktree', 'create', '--repo', 'r'] })).toBe(300_000)
  })

  it('extends the timeout for wait-style commands', () => {
    expect(remoteCliRequestTimeoutMs({ argv: ['terminal', 'wait', '--for', 'exit'] })).toBe(600_000)
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['orchestration', 'check', '--wait', '--json']
      })
    ).toBe(600_000)
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['orchestration', 'ask', '--to', 'term_x', '--question', 'ok?']
      })
    ).toBe(600_000)
  })

  it('extends past an explicit --timeout-ms waiter budget', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['terminal', 'wait', '--for', 'exit', '--timeout-ms', '1800000']
      })
    ).toBe(1_860_000)
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['orchestration', 'check', '--wait', '--timeout-ms=1800000']
      })
    ).toBe(1_860_000)
  })

  it('keeps the wait base budget when --timeout-ms is small', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['terminal', 'wait', '--for', 'exit', '--timeout-ms', '5000']
      })
    ).toBe(600_000)
  })

  it('does not treat a flag value named wait as a command path element', () => {
    expect(remoteCliRequestTimeoutMs({ argv: ['terminal', 'read', '--terminal', 'wait'] })).toBe(
      300_000
    )
  })

  it('falls back to the relay default for malformed argv', () => {
    expect(remoteCliRequestTimeoutMs({ argv: 'status' })).toBeUndefined()
    expect(remoteCliRequestTimeoutMs({})).toBeUndefined()
  })
})
