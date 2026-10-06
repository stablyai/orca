import { describe, expect, it } from 'vitest'
import { ORCA_SESSION_ID_AS_ADDRESS } from '../shared/orca-session-id-wording-test-fixture'
import type { CliStatusCaller } from '../shared/orchestration-caller-status'
import { formatCliStatus } from './format'
import { ROOT_HELP_TEXT_PRIMARY } from './root-help-text-primary'
import { CORE_COMMAND_SPECS } from './specs/core'
import { ORCHESTRATION_COMMAND_SPECS } from './specs/orchestration'

// The guide, preamble and refusals are checked in agent-facing-parity.test.ts.
describe('CLI text about an Orca session ID', () => {
  const status = (caller: CliStatusCaller) =>
    formatCliStatus({
      app: { running: true, pid: 1 },
      runtime: { state: 'ready', reachable: true, runtimeId: 'runtime_1' },
      graph: { state: 'ready' },
      caller
    })

  it.each([
    [
      'help and specs',
      [
        JSON.stringify([...CORE_COMMAND_SPECS, ...ORCHESTRATION_COMMAND_SPECS]),
        ...ROOT_HELP_TEXT_PRIMARY
      ]
    ],
    [
      'orca status',
      [
        status({
          orcaSessionId: 'orca_session_id:4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37',
          live: true
        }),
        status({ live: false, refusal: { code: 'session_caller_not_live', message: 'ended' } })
      ]
    ]
  ])('never calls it an address in %s', (_where, texts) => {
    for (const text of texts) {
      expect(text).not.toMatch(ORCA_SESSION_ID_AS_ADDRESS)
    }
  })

  it('names it as the Orca session ID in orca status', () => {
    expect(
      status({ orcaSessionId: 'orca_session_id:4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37', live: true })
    ).toContain('\norcaSessionId: orca_session_id:4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
  })
})
