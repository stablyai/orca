import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_FAILURE_KINDS,
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  providerDiagnostic,
  withProviderDiagnostic
} from '../../../shared/agent-session-failure'
import { AgentSessionRefusalError, refuse } from '../../../shared/agent-session-wire-refusals'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { MAX_UNEXPECTED_EXIT_REASON_CHARS } from './structured-agent-session-dead-generation-settlement'
import {
  agentSessionFailureText,
  structuredAgentSessionStartFailure
} from './structured-agent-session-failure-text'

/** What Orca's own error text looks like: a code, a marker, a uuid, a path, an exception. */
const ORCA_INTERNAL =
  /agent_session_|execution_owner|provider_[a-z_]+|[0-9a-f]{8}-[0-9a-f]{4}-|[/\\][\w.-]+[/\\]|Error:|ENOENT/

describe('the sentence the host persists', () => {
  it.each(AGENT_SESSION_FAILURE_KINDS)('for %s is written for a person', (kind) => {
    const text = agentSessionFailureText(
      {
        kind,
        // A log detail and a refusal ride with the fact; neither may reach the sentence.
        detail: {
          text: 'Error: ENOENT /Users/me/.claude/x agent_session_conflict',
          audience: 'log'
        },
        refusal: { code: 'agent_session_conflict', cause: 'claimConflicted' }
      },
      { agentName: 'Claude' }
    )
    expect(text).not.toMatch(ORCA_INTERNAL)
    expect(text).toMatch(/[.]$/)
  })

  it('quotes a provider sentence written for a person, bounded, and never a log', () => {
    expect(
      agentSessionFailureText({
        kind: 'providerRejected',
        detail: { text: 'thread not found.', audience: 'person' }
      })
    ).toBe('The provider did not accept this message: thread not found.')
    expect(
      agentSessionFailureText({
        kind: 'providerRejected',
        detail: { text: 'panic at main.rs:4', audience: 'log' }
      })
    ).toBe('The provider did not accept this message.')
  })

  it('offers a new chat only when nothing here can restart this one', () => {
    const text = (code: 'agent_session_identity_required' | 'agent_session_conflict') =>
      agentSessionFailureText({ kind: 'restartFailed', refusal: { code } }, { agentName: 'Codex' })
    expect(text('agent_session_identity_required')).toBe(
      "Codex couldn't restart. Start a new chat to continue."
    )
    expect(text('agent_session_conflict')).toBe("Codex couldn't restart.")
  })
})

describe('structuredAgentSessionStartFailure', () => {
  it('keeps a provider diagnostic only when the error carried one', () => {
    const carried = withProviderDiagnostic(
      new Error('claude stream-json exited (code 1): boom'),
      providerDiagnostic('code 1\nboom', 'log')
    )
    expect(structuredAgentSessionStartFailure({ error: carried })).toEqual({
      text: 'The provider stopped before it finished starting.',
      failure: { kind: 'providerStartFailed', detail: { text: 'code 1\nboom', audience: 'log' } }
    })
    // Orca's own words, however provider-like, are never promoted to a detail.
    expect(
      structuredAgentSessionStartFailure({ error: new Error('Not logged in. Run /login.') }).failure
    ).toEqual({ kind: 'providerStartFailed' })
  })

  it('keeps a start refusal the adapter typed', () => {
    const refusal = new AgentSessionAcquisitionRefusal(
      'Claude is not signed in for the selected account.',
      'agent_session_operation_invalid',
      'notSignedIn'
    )
    expect(structuredAgentSessionStartFailure({ error: refusal }, { agentName: 'Claude' })).toEqual(
      {
        text: 'Claude is not signed in for the selected account. Sign in, then send your message again.',
        failure: { kind: 'notSignedIn' }
      }
    )
  })

  it('words a refused restart by its situation, never its message', () => {
    const words = structuredAgentSessionStartFailure(
      {
        refusal: refuse(
          'agent_session_ownership_unknown',
          'ownerUnproven',
          'Orca cannot prove that process 4242 on host-1 has exited.'
        )
      },
      { agentName: 'Claude' }
    )
    expect(words).toEqual({
      text: "Claude couldn't restart.",
      failure: {
        kind: 'restartFailed',
        refusal: { code: 'agent_session_ownership_unknown', cause: 'ownerUnproven' }
      }
    })
  })

  it("reads an exit before the start as a failed start, and an Orca fault as Orca's", () => {
    expect(
      structuredAgentSessionStartFailure({
        exit: { kind: 'providerExited', detail: { text: 'stderr', audience: 'log' } }
      }).failure
    ).toEqual({ kind: 'providerStartFailed', detail: { text: 'stderr', audience: 'log' } })
    expect(structuredAgentSessionStartFailure({ exit: { kind: 'hostFault' } }).failure).toEqual({
      kind: 'hostFault'
    })
    expect(structuredAgentSessionStartFailure({ hostFault: true }).text).not.toMatch(ORCA_INTERNAL)
  })

  it("holds any provider detail to the lease record's cap", () => {
    expect(MAX_PROVIDER_DIAGNOSTIC_CHARS).toBe(512)
    expect(MAX_UNEXPECTED_EXIT_REASON_CHARS).toBe(MAX_PROVIDER_DIAGNOSTIC_CHARS)
    const long = 'x'.repeat(4_000)
    // However the caller built the detail, the fact stores at most the cap.
    const words = structuredAgentSessionStartFailure({
      diagnostic: { text: long, audience: 'log' }
    })
    expect(words.failure.detail?.text).toHaveLength(MAX_UNEXPECTED_EXIT_REASON_CHARS)
    expect(
      structuredAgentSessionStartFailure({
        exit: { kind: 'providerExited', detail: { text: long, audience: 'log' } }
      }).failure.detail?.text
    ).toHaveLength(MAX_UNEXPECTED_EXIT_REASON_CHARS)
  })

  it('reads a thrown refusal the same as a returned one', () => {
    const thrown = new AgentSessionRefusalError(
      refuse('agent_session_conflict', 'claimConflicted', 'Another process claims this session.')
    )
    expect(thrown.message).toBe('agent_session_conflict')
    expect(structuredAgentSessionStartFailure({ refusal: thrown.refusal }).failure).toEqual({
      kind: 'restartFailed',
      refusal: { code: 'agent_session_conflict', cause: 'claimConflicted' }
    })
  })
})
