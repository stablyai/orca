import { describe, expect, it } from 'vitest'
import { decideAfterServeChildExit, type ServeChildExit } from './serve-supervisor-policy'

const HANDOFF = {
  schemaVersion: 1 as const,
  phase: 'install-requested' as const,
  fromVersion: '1.0.0',
  targetVersion: '1.1.0',
  servingPid: 42
}

function exit(overrides: Partial<ServeChildExit> = {}): ServeChildExit {
  return {
    code: 0,
    signal: null,
    readiness: 'not-expected',
    signalWasForwarded: false,
    childPid: 42,
    ...overrides
  }
}

describe('decideAfterServeChildExit', () => {
  it('passes a normal exit code through, and explains an unforwarded signal', () => {
    const base = { expectedHandoff: null, handoff: null, hasHandoffPath: true }
    expect(decideAfterServeChildExit({ ...base, exit: exit({ code: 3 }) })).toEqual({
      kind: 'exit',
      code: 3
    })
    expect(
      decideAfterServeChildExit({
        ...base,
        exit: exit({ code: null, signal: 'SIGTERM', signalWasForwarded: true })
      })
    ).toEqual({ kind: 'exit', code: 0 })
    expect(
      decideAfterServeChildExit({ ...base, exit: exit({ code: null, signal: 'SIGABRT' }) })
    ).toEqual({ kind: 'signal-exit', signal: 'SIGABRT' })
  })

  it('waits for the new bundle only when this very child requested the install', () => {
    expect(
      decideAfterServeChildExit({
        exit: exit(),
        expectedHandoff: null,
        handoff: HANDOFF,
        hasHandoffPath: true
      })
    ).toEqual({ kind: 'await-install', handoff: HANDOFF })
    expect(
      decideAfterServeChildExit({
        exit: exit({ childPid: 7 }),
        expectedHandoff: null,
        handoff: HANDOFF,
        hasHandoffPath: true
      })
    ).toEqual({ kind: 'exit', code: 0 })
    expect(
      decideAfterServeChildExit({
        exit: exit(),
        expectedHandoff: null,
        handoff: HANDOFF,
        hasHandoffPath: false
      })
    ).toEqual({ kind: 'exit', code: 0 })
  })

  it('fails an update whose replacement exited before serving the target version', () => {
    expect(
      decideAfterServeChildExit({
        exit: exit({ readiness: 'pending' }),
        expectedHandoff: HANDOFF,
        handoff: null,
        hasHandoffPath: true
      })
    ).toEqual({
      kind: 'fail-replacement',
      handoff: HANDOFF,
      reason: 'Replacement exited before serving version 1.1.0.'
    })
    expect(
      decideAfterServeChildExit({
        exit: exit({ readiness: 'failed' }),
        expectedHandoff: HANDOFF,
        handoff: null,
        hasHandoffPath: true
      })
    ).toEqual({ kind: 'exit', code: 1 })
  })
})
