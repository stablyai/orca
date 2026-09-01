// Ledger #12: the host is the single minting authority for an automation run's
// persisted launch-failure wrapper. These cover the three field states — absent
// (preserve), present-null (clear), present-value (mint) — and prove a
// client-supplied wrapper is re-minted so it can never win over the host.
import { describe, expect, it } from 'vitest'
import type { PersistedAgentLaunchFailure } from '../../shared/agent-launch-contract'
import type { AutomationDispatchResult } from '../../shared/automations-types'
import { parsePersistedAgentLaunchFailure } from '../../shared/agent-launch-failure-schema'
import {
  mintPersistedAutomationLaunchFailure,
  stampAutomationDispatchLaunchFailure
} from './automation-launch-failure-stamp'

// The only keys a persisted launch failure may carry. Any command/argv/env
// key-or-value, label, or path text would show up as a key outside this set.
const ALLOWED_FAILURE_KEYS = new Set([
  'code',
  'requestedAgent',
  'baseAgent',
  'variable',
  'field',
  'shell',
  'reason',
  'version',
  'failureId',
  'intent',
  'occurredAt'
])

describe('stampAutomationDispatchLaunchFailure (ledger #12)', () => {
  it('mints the persisted wrapper for a plain failure from the dispatch arm', () => {
    const result: AutomationDispatchResult = {
      runId: 'run-1',
      status: 'dispatch_failed',
      error: 'launch failed',
      agentLaunchFailure: {
        code: 'invalid_launch_snapshot',
        requestedAgent: 'custom-agent:codex:11111111-1111-4111-8111-111111111111',
        baseAgent: 'codex'
      }
    }

    const stamped = stampAutomationDispatchLaunchFailure(result)

    expect(stamped.agentLaunchFailure).toMatchObject({
      code: 'invalid_launch_snapshot',
      requestedAgent: 'custom-agent:codex:11111111-1111-4111-8111-111111111111',
      baseAgent: 'codex',
      version: 1,
      intent: 'automation'
    })
    expect(stamped.agentLaunchFailure?.failureId).toBeTruthy()
    expect(typeof stamped.agentLaunchFailure?.occurredAt).toBe('number')
  })

  it('re-mints a client-supplied wrapper so the host id always wins', () => {
    // A wrapper the client tried to forge (Persisted is assignable to the plain
    // wire field). The stamp must overwrite the id and time.
    const clientWrapper: PersistedAgentLaunchFailure = {
      code: 'invalid_launch_snapshot',
      version: 1,
      failureId: 'client-forged-id',
      intent: 'automation',
      occurredAt: 42
    }
    const result: AutomationDispatchResult = {
      runId: 'run-1',
      status: 'dispatch_failed',
      agentLaunchFailure: clientWrapper
    }

    const stamped = stampAutomationDispatchLaunchFailure(result)

    expect(stamped.agentLaunchFailure?.failureId).not.toBe('client-forged-id')
    expect(stamped.agentLaunchFailure?.occurredAt).not.toBe(42)
  })

  it('preserves the run failure when the field is absent', () => {
    const result: AutomationDispatchResult = { runId: 'run-1', status: 'dispatched' }

    const stamped = stampAutomationDispatchLaunchFailure(result)

    expect('agentLaunchFailure' in stamped).toBe(false)
  })

  it('clears the failure when the field is present and null', () => {
    const result: AutomationDispatchResult = {
      runId: 'run-1',
      status: 'completed',
      agentLaunchFailure: null
    }

    const stamped = stampAutomationDispatchLaunchFailure(result)

    expect('agentLaunchFailure' in stamped).toBe(true)
    expect(stamped.agentLaunchFailure).toBeNull()
  })
})

// G6 secret-leak oracle for the automation owner record: the persisted wrapper
// round-trips through JSON with no command/argv/env/label/path text, normalizes
// back through the strict schema, and a request error or a secret-bearing blob
// fails normalization rather than persisting.
describe('automation launch-failure round trip (G6)', () => {
  it('round-trips a minted failure with only whitelisted keys and no secret text', () => {
    const minted = mintPersistedAutomationLaunchFailure({
      code: 'invalid_agent_env',
      requestedAgent: 'custom-agent:codex:11111111-1111-4111-8111-111111111111',
      baseAgent: 'codex',
      field: 'env'
    })
    const roundTripped = JSON.parse(JSON.stringify(minted))
    // Exactly the whitelist — no argv/env/command/label/path key survives.
    for (const key of Object.keys(roundTripped)) {
      expect(ALLOWED_FAILURE_KEYS.has(key)).toBe(true)
    }
    // Normalization holds on the way back in.
    expect(parsePersistedAgentLaunchFailure(roundTripped)).toEqual(minted)
  })

  it('drops extra keys a forged client failure tries to smuggle into the mint', () => {
    const forged = {
      code: 'spawn_failed',
      agentEnv: { TOKEN: 'x' },
      argv: ['--secret'],
      label: 'evil'
    } as unknown as Parameters<typeof mintPersistedAutomationLaunchFailure>[0]
    const minted = mintPersistedAutomationLaunchFailure(forged)
    for (const key of Object.keys(minted)) {
      expect(ALLOWED_FAILURE_KEYS.has(key)).toBe(true)
    }
    expect('agentEnv' in minted).toBe(false)
  })

  it('rejects a stored blob carrying secret env/argv text on read', () => {
    const minted = mintPersistedAutomationLaunchFailure({ code: 'spawn_failed' })
    expect(parsePersistedAgentLaunchFailure({ ...minted, agentEnv: { TOKEN: 'x' } })).toBeNull()
    expect(parsePersistedAgentLaunchFailure({ ...minted, argv: ['--secret'] })).toBeNull()
  })

  it('a request error cannot parse as the persisted automation failure', () => {
    expect(
      parsePersistedAgentLaunchFailure({
        code: 'idempotency_conflict',
        version: 1,
        failureId: 'x',
        intent: 'automation',
        occurredAt: 1
      })
    ).toBeNull()
  })
})
