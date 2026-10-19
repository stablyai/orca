// A refusal's details name the situation, so every place that answers for a refusal — the first
// reply, a ledger replay, the store fallback copy — must name the same one.

import { describe, expect, it } from 'vitest'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../shared/agent-session-record.test-fixture'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { classifyStoreFailure } from './structured-agent-session-attach'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError
} from './structured-agent-session-adapter'
import {
  failedAcquisitionRefusal,
  failedAcquisitionSettlement
} from './structured-agent-session-failed-create-refusal'
import { withObservedProviderExit } from './structured-agent-session-failure-text'
import { withMissingProviderExecutable } from '../../provider-process/provider-executable-missing'
import { providerDiagnostic, withProviderDiagnostic } from '../../../shared/agent-session-failure'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'

const CLAUDE_CREATE = {
  record: agentSessionRecordFixture(),
  newSession: true
}

function replay(outcome: Parameters<typeof resolveAgentSessionReplayOutcome>[0]['outcome']) {
  return resolveAgentSessionReplayOutcome({
    operationId: 'op-1',
    outcome,
    reconstruct: () => null
  })
}

describe('a ledger replay names the details its first answer did', () => {
  it('keeps ACP startup detail and direct-create guidance in the first reply and replay', () => {
    const error = withProviderDiagnostic(
      new AgentSessionAcquisitionRefusal('signed out', 'notSignedIn'),
      providerDiagnostic('Grok needs its API key.', 'person')
    )
    const wording = {
      record: { ...agentSessionRecordFixture(), provider: 'grok' as const },
      newSession: true
    }
    const first = failedAcquisitionRefusal(error, wording)
    const replayed = replay(failedAcquisitionSettlement(error, wording).outcome)
    expect(first?.refusal.message).toBe(
      'Sign in to Grok with `grok login` on the computer running this chat. Grok needs its API key.'
    )
    expect(replayed).toMatchObject({ refusal: { message: first?.refusal.message } })
  })
  it.each([
    [new AgentSessionAcquisitionRefusal('not signed in', 'notSignedIn'), 'notSignedIn'],
    [
      new AgentSessionAcquisitionExitProvenError(
        withObservedProviderExit(new Error('exited (code 1)'))
      ),
      'providerStartFailed'
    ],
    // Gone now, with no exit observed: no situation, on the first answer or the replay.
    [new AgentSessionAcquisitionExitProvenError(new Error('spawn codex ENOENT')), undefined],
    // Its own spawn found no executable: the CLI is not installed.
    [
      new AgentSessionAcquisitionExitProvenError(
        withObservedProviderExit(withMissingProviderExecutable(new Error('exited (code 127)')))
      ),
      'cliMissing'
    ]
  ])('for a failed create: %s', (error, reason) => {
    const first = failedAcquisitionRefusal(error, CLAUDE_CREATE)
    const replayed = replay(failedAcquisitionSettlement(error, CLAUDE_CREATE).outcome)
    expect(first?.refusal.details?.reason).toBe(reason)
    expect(replayed).toMatchObject({
      decision: 'refuse',
      refusal: { code: first?.refusal.code, ...(reason ? { details: first?.refusal.details } : {}) }
    })
    if (!reason) {
      expect(replayed).not.toHaveProperty('refusal.details')
    }
  })

  it.each(['managed', 'system'] as const)(
    'keeps %s sign-in instructions in the first reply and ledger replay',
    (account) => {
      const error = new AgentSessionAcquisitionRefusal('signed out', 'notSignedIn', account)
      const first = failedAcquisitionRefusal(error, CLAUDE_CREATE)
      const replayed = replay(failedAcquisitionSettlement(error, CLAUDE_CREATE).outcome)
      expect(first?.refusal.details).toEqual({ reason: 'notSignedIn', account })
      expect(replayed).toMatchObject({
        refusal: { details: first?.refusal.details, message: first?.refusal.message }
      })
      expect(first?.refusal.message).toContain(
        account === 'system'
          ? 'Run `claude auth login`'
          : 'Sign in again in Claude Accounts settings.'
      )
    }
  )

  it('for a create whose cleanup could not prove the child gone', () => {
    const outcome = failedAcquisitionSettlement(
      new AgentSessionAcquisitionExitUnprovenError(new Error('probe failed')),
      CLAUDE_CREATE
    ).outcome
    expect(replay(outcome)).toMatchObject({
      refusal: { code: 'agent_session_ownership_unknown', details: { reason: 'ownerUnproven' } }
    })
  })

  it.each([
    [
      new AgentSessionAcquisitionExitProvenError(
        withObservedProviderExit(
          new Error('claude stream-json exited (code 1): claude: not signed in (rig)')
        )
      ),
      'Claude stopped before it finished starting. Send your message to try again.'
    ],
    [
      new AgentSessionAcquisitionExitProvenError(new Error('spawn claude ENOENT')),
      "Claude couldn't start. Send your message to try again."
    ],
    [
      new AgentSessionAcquisitionRefusal(
        'Claude is not signed in for the selected account. Sign in with the Claude CLI for this CLAUDE_CONFIG_DIR, then retry.',
        'notSignedIn'
      ),
      "Claude isn't signed in. Run `claude auth login`, or choose an account in Claude Accounts settings."
    ],
    [
      AgentSessionAcquisitionRefusal.historyTooLarge(
        'Codex thread history exceeds the bounded restore queue; history was not partially imported.'
      ),
      "This conversation's history is too large to restore here. Start a new chat to continue."
    ]
  ])('answers and replays %s in the sentence its start failure reads as', (error, sentence) => {
    const first = failedAcquisitionRefusal(error, CLAUDE_CREATE)
    const replayed = replay(failedAcquisitionSettlement(error, CLAUDE_CREATE).outcome)
    expect(first?.refusal.message).toBe(sentence)
    expect(replayed).toMatchObject({ decision: 'refuse', refusal: { message: sentence } })
    for (const message of [
      first?.refusal.message,
      failedAcquisitionSettlement(error, CLAUDE_CREATE).outcome.message
    ]) {
      expect(message).not.toMatch(
        /stream-json|exited \(code|ENOENT|CLAUDE_CONFIG_DIR|restore queue/
      )
    }
  })

  it('replays a spawn that failed before any process in a sentence, not its error', () => {
    const outcome = failedAcquisitionSettlement(
      new AgentSessionPreSpawnError(new Error('spawn claude ENOENT')),
      CLAUDE_CREATE
    ).outcome
    expect(replay(outcome)).toMatchObject({
      refusal: { message: "Claude couldn't start. Send your message to try again." }
    })
  })

  it('keeps the code a store refusal replays with, and the unproven-exit marker', () => {
    expect(
      failedAcquisitionSettlement(new Error('agent_session_conflict'), CLAUDE_CREATE).outcome
        .message
    ).toBe('agent_session_conflict')
    expect(
      failedAcquisitionSettlement(
        new AgentSessionAcquisitionExitUnprovenError(new Error('probe failed')),
        CLAUDE_CREATE
      ).outcome.message
    ).toBe('agent_session_acquisition_exit_unproven')
  })

  it('replays the facts beside the reason, and mirrors them where released clients read', () => {
    const resolution = {
      state: 'resolved' as const,
      selectedOptionId: 'allow',
      resolvedBy: 'phone',
      resolvedAt: 5
    }
    const replayed = replay({
      status: 'failed',
      code: 'agent_session_item_revision_stale',
      details: { reason: 'promptMoved', currentRevision: 3, resolution }
    })
    expect(replayed).toMatchObject({
      refusal: {
        code: 'agent_session_item_revision_stale',
        details: { reason: 'promptMoved', currentRevision: 3, resolution },
        currentRevision: 3,
        resolution
      }
    })
  })

  it('reads a row an older host wrote, with no details, as naming none', () => {
    const replayed = replay({ status: 'failed', code: 'agent_session_conflict' })
    expect(replayed).toMatchObject({ refusal: { code: 'agent_session_conflict' } })
    expect(replayed.decision === 'refuse' && replayed.refusal).not.toHaveProperty('details')
  })

  it('drops the cause an unreleased build wrote, and a reason the code does not list', () => {
    for (const row of [
      { status: 'failed' as const, code: 'agent_session_conflict', cause: 'claimConflicted' },
      {
        status: 'failed' as const,
        code: 'agent_session_conflict',
        details: { reason: 'promptGone' as const }
      }
    ]) {
      const replayed = replay(row)
      expect(replayed).toMatchObject({ refusal: { code: 'agent_session_conflict' } })
      expect(replayed.decision === 'refuse' && replayed.refusal).not.toHaveProperty('details')
    }
  })

  it('names a code this build cannot place as refused earlier', () => {
    expect(replay({ status: 'failed', code: 'agent_session_future_code' })).toMatchObject({
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'operationRefusedEarlier' }
      }
    })
  })

  it('names a lost outcome and a lost result', () => {
    expect(replay({ status: 'unknown' })).toMatchObject({
      refusal: { details: { reason: 'outcomeUnknown' } }
    })
    expect(replay({ status: 'succeeded', sessionId: 's' })).toMatchObject({
      refusal: { details: { reason: 'resultLost' } }
    })
  })
})

describe('the store fallback copy', () => {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-1' }
    })
  )

  it('words a situation its code would misdescribe by the situation', () => {
    const refusal = classifyStoreFailure(
      agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'replaySuperseded' }),
      null,
      record
    )
    expect(refusal).toMatchObject({
      code: 'agent_session_ownership_unknown',
      details: { reason: 'replaySuperseded' }
    })
    // Not the latched-owner story: this owner is not in doubt, the replay is just stale.
    expect(refusal.message).not.toContain('4242')
  })

  it('keeps the latched-owner story, with its reason, for an owner it cannot prove gone', () => {
    const refusal = classifyStoreFailure(
      agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' }),
      null,
      record
    )
    expect(refusal.details?.reason).toBe('ownerUnproven')
    expect(refusal.message).toContain('4242')
  })

  it('does not promise an update fixes a record this build cannot read', () => {
    // Unreadable covers a damaged record as well as one a newer build wrote.
    expect(
      classifyStoreFailure(
        agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' }),
        null,
        null
      )
    ).toEqual({
      code: 'execution_owner_reconciling',
      details: { reason: 'recordUnreadable' },
      message:
        "Orca can't read this chat's saved state. If a newer version of Orca saved it, update Orca to open it; otherwise start a new chat."
    })
  })

  it('names the latch for a bare code an older path still throws', () => {
    expect(
      classifyStoreFailure(new Error('agent_session_conflict'), null, {
        ...record,
        lease: { ...record.lease, claimStatus: 'conflicted' }
      }).details
    ).toEqual({ reason: 'claimConflicted' })
    expect(
      classifyStoreFailure(new Error('agent_session_conflict'), null, null)
    ).not.toHaveProperty('details')
  })

  it('puts the current fence in the details of a stale checkpoint, and mirrors it', () => {
    expect(
      classifyStoreFailure(
        agentSessionRefusalError('agent_session_checkpoint_stale', { reason: 'fenceStale' }),
        7,
        null
      )
    ).toEqual({
      code: 'agent_session_checkpoint_stale',
      details: { reason: 'fenceStale', currentFence: 7 },
      currentFence: 7,
      message: 'The session store refused this call: agent_session_checkpoint_stale.'
    })
    // A bare code names no reason, but the fence is still a fact.
    expect(
      classifyStoreFailure(new Error('agent_session_checkpoint_stale'), 7, null)
    ).toMatchObject({ details: { currentFence: 7 }, currentFence: 7 })
  })
})
