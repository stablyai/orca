import { describe, expect, it } from 'vitest'
import type { CliStatusResult } from '../shared/runtime-types'
import { formatCliStatus } from './format'

const status: CliStatusResult = {
  app: { running: false, pid: null },
  runtime: { state: 'not_running', reachable: false, runtimeId: null },
  graph: { state: 'not_running' }
}

const orcaSessionId = 'orca_session_id:4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'

describe('formatCliStatus daemon and caller integration', () => {
  it.each([0, 2, null])('preserves caller identity alongside daemon count %s', (sessionCount) => {
    const output = formatCliStatus({
      ...status,
      caller: { orcaSessionId, live: true },
      daemon: { reachable: true, sessionCount }
    })

    expect(output).toContain(`\norcaSessionId: ${orcaSessionId}`)
    expect(output).toContain('\ndaemonReachable: true')
    expect(output).toContain(`\ndaemonSessionCount: ${sessionCount ?? 'unknown'}`)
  })

  it('preserves a caller refusal alongside an unreachable daemon', () => {
    const output = formatCliStatus({
      ...status,
      caller: { live: false, refusal: { code: 'session_caller_not_live', message: 'ended' } },
      daemon: { reachable: false, sessionCount: null }
    })

    expect(output).toContain('\norcaSessionId: none (refused: session_caller_not_live)')
    expect(output).toContain('\ndaemonReachable: false\ndaemonSessionCount: unknown')
  })

  it('omits daemon and caller lines when neither field is present', () => {
    const output = formatCliStatus(status)

    expect(output).not.toContain('daemon')
    expect(output).not.toContain('orcaSessionId:')
    expect(output).toContain('graphState: not_running')
  })
})
