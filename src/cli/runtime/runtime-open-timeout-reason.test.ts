import { describe, expect, it } from 'vitest'
import { describeOpenTimeout } from './runtime-open-timeout-reason'
import type { CliRuntimeUnreachableReason, CliStatusResult } from '../../shared/runtime-types'

// Why: the poll loop can only feed this the states today's local producer happens to emit, so
// driving it through the client leaves whole arms unpinned. Each arm is a promise about what
// the message may claim, so each one is asserted against the status it describes (STA-3969).
function status(overrides: {
  appRunning: boolean
  reachable: boolean
  state: CliStatusResult['runtime']['state']
  unreachableReason?: CliRuntimeUnreachableReason
}): CliStatusResult {
  return {
    app: { running: overrides.appRunning, pid: overrides.appRunning ? 4242 : null },
    runtime: {
      state: overrides.state,
      reachable: overrides.reachable,
      runtimeId: overrides.reachable ? 'runtime-1' : null,
      ...(overrides.unreachableReason ? { unreachableReason: overrides.unreachableReason } : {})
    },
    graph: { state: overrides.reachable ? 'ready' : 'unreachable' }
  }
}

const history: CliRuntimeUnreachableReason = {
  code: 'endpoint_missing',
  message: 'Orca published the socket /tmp/never-listened.sock, but it does not exist.',
  endpoint: '/tmp/never-listened.sock',
  endpointKind: 'unix'
}

describe('describeOpenTimeout', () => {
  it('reports the current reason as the live diagnosis', () => {
    const text = describeOpenTimeout(
      status({
        appRunning: true,
        reachable: false,
        state: 'unreachable',
        unreachableReason: history
      }),
      undefined
    )
    expect(text).toContain('the Orca app process is running but its runtime is unreachable')
    expect(text).toContain(history.message)
  })

  it('calls a rejected request an answer, never unreachable', () => {
    const text = describeOpenTimeout(
      status({
        appRunning: true,
        reachable: false,
        state: 'unreachable',
        unreachableReason: { ...history, code: 'request_rejected', message: 'refused: bad token' }
      }),
      undefined
    )
    expect(text).toContain('answered but refused the status request')
    expect(text).not.toContain('unreachable')
  })

  it('says the runtime answered when the newest poll was reachable', () => {
    const text = describeOpenTimeout(
      status({ appRunning: true, reachable: true, state: 'graph_not_ready' }),
      history
    )
    expect(text).toContain('is responding and still running headlessly')
    // A poll that answered resolves the earlier failure, so it is not even history any more.
    expect(text).not.toContain(history.message)
  })

  // Why: this is the arm the client's own producer cannot currently reach, and dropping it makes
  // the message claim no process is running while the pid is alive — the exact false report
  // STA-3969 exists to stop.
  it('never claims the process is gone while the newest status says it is running', () => {
    const text = describeOpenTimeout(
      status({ appRunning: true, reachable: false, state: 'graph_not_ready' }),
      undefined
    )
    expect(text).toBe('. The runtime may still be running headlessly.')
    expect(text).not.toContain('no longer running')
    expect(text).not.toContain('No Orca runtime is running')
  })

  it('reports a dead app process without inheriting the old live verdict', () => {
    const text = describeOpenTimeout(
      status({ appRunning: false, reachable: false, state: 'stale_bootstrap' }),
      history
    )
    expect(text).toContain('The Orca app process is no longer running.')
    expect(text).toContain('The last failure it reported was:')
    expect(text).not.toContain('but its runtime is unreachable')
  })

  it('says no runtime is running when none was ever published, with no history to add', () => {
    const text = describeOpenTimeout(
      status({ appRunning: false, reachable: false, state: 'not_running' }),
      undefined
    )
    expect(text).toBe('. No Orca runtime is running.')
  })
})
