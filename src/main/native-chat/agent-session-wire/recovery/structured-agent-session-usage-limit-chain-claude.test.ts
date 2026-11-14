import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { ClaudeStructuredSessionAdapter } from '../../../claude/structured/claude-structured-session-adapter'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from '../../../claude/structured/claude-structured-session-test-support'
import { claudeStartupSettled } from '../../../claude/structured/claude-structured-startup-settled-test-support'
import { createFixture } from '../../agent-session-journal/store-lifecycle/journal-store-contract-test-fixture'
import { createDeferredStructuredAgentSessionEventSink } from '../journal-ingress/structured-agent-session-event-sink'
import {
  usageLimitContinueChain,
  usageLimitContinueMessageId,
  usageLimitContinueTag
} from './structured-agent-session-usage-limit-chain'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('capture event is not a record')
  }
  return value
}

const fixture = createFixture()

it('counts a host continue whose recorded Claude echo opens the turn under its provider key', async () => {
  const at = 1_700_000_200_000
  const identity = identityFor()
  const journal = await fixture.open({ identity })
  const previous = await journal.appendItem(
    { provider: 'orca', clientMessageId: 'previous-turn' },
    {
      kind: 'turn',
      turnId: 'previous-turn',
      state: 'completed',
      outcome: 'failure',
      userItemId: 'previous-user',
      completedAt: at - 2_000
    },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const previousCut = { turnItemId: previous.itemId, resetsAt: at - 1_000 }
  const limitBody = (resetsAt: number) =>
    ({
      kind: 'status',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt } }),
        { surface: 'row' }
      )
    }) satisfies Parameters<typeof journal.appendItem>[1]
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'previous-limit' },
    limitBody(previousCut.resetsAt),
    { fence: 7, turnScope: { kind: 'turn', turnItemId: previous.itemId } }
  )
  const clientMessageId = usageLimitContinueMessageId(
    at,
    usageLimitContinueTag(previousCut),
    '0123456789abcdef'
  )
  const capture = readFileSync(
    join(__dirname, '../../../claude/__fixtures__/claude-lifecycle-capture-batch-lead.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => record(JSON.parse(line)))
  const capturedSessionId = capture[0]!.providerSessionId
  if (typeof capturedSessionId !== 'string') {
    throw new Error('capture has no provider session ID')
  }
  const claude = fakeClaude({ initProof: 'none', replayUuid: null })
  const sink = createDeferredStructuredAgentSessionEventSink({
    sessionId: identity.sessionId,
    logger: { warn: () => {}, error: () => {} }
  })
  sink.bind({ journal, fence: 7, publish: () => {} })
  const settlements: Promise<unknown>[] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      cliFlag: async () => 'supported',
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1,
    now: () => at,
    persistHandle: async () => {},
    onDispatchSettledLate: (settlement) => {
      if ('providerIdentity' in settlement) {
        settlements.push(
          journal.resolveDispatch({
            clientMessageId: settlement.clientMessageId,
            state: 'accepted',
            providerIdentity: settlement.providerIdentity,
            fence: 7
          })
        )
      }
    }
  })
  try {
    await adapter.acquire({ identity, fence: 7, spawnToken: 'spawn-9', events: sink.sink })
    const connection = claude.connections[0]!
    let capturedUuid = ''
    let sentUuid = ''
    for (const event of capture) {
      if (event.kind === 'dispatch') {
        if (typeof event.sentUuid !== 'string' || typeof event.text !== 'string') {
          throw new Error('capture dispatch has no UUID or text')
        }
        await claudeStartupSettled(adapter, identity.sessionId)
        const body = {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: event.text }]
        } satisfies Parameters<typeof adapter.dispatch>[0]['body']
        await journal.appendSubmission({
          clientMessageId,
          payloadFingerprint: 'captured-continue',
          body,
          origin: 'host',
          fence: 7
        })
        await expect(
          adapter.dispatch({ sessionId: identity.sessionId, clientMessageId, body, fence: 7 })
        ).resolves.toMatchObject({ state: 'admitted' })
        capturedUuid = event.sentUuid
        sentUuid = String(connection.sent.at(-1)!.uuid)
      } else if (event.kind === 'frame') {
        let frame = JSON.stringify(event.frame).replaceAll(capturedSessionId, PROVIDER_SESSION_ID)
        if (capturedUuid) {
          frame = frame.replaceAll(capturedUuid, sentUuid)
        }
        const mapped = record(JSON.parse(frame))
        connection.handlers.onMessage?.(mapped)
        // The capture continues with queued sends; this regression ends at the first send's echo.
        if (mapped.type === 'user') {
          break
        }
      }
    }
    await Promise.all(settlements)
    expect(await sink.drained()).toEqual({ ok: true })
    const echoed = journal.snapshot()
    const turnItem = echoed.items.findLast((item) => readAgentJournalTurn(item.body))
    const submission = echoed.submissions.find((input) => input.clientMessageId === clientMessageId)
    if (!turnItem || !submission?.providerItemId) {
      throw new Error('Claude echo did not open a turn and settle the submission')
    }
    expect(readAgentJournalTurn(turnItem.body)?.userItemId).toBe(submission.providerItemId)
    expect(submission.providerItemId).not.toBe(agentJournalSubmissionKey(clientMessageId))
    expect(submission.dispatchState).toBe('accepted')
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'continued-limit' },
      limitBody(at + 1_000),
      { fence: 7, turnScope: { kind: 'turn', turnItemId: turnItem.itemId } }
    )
    const snapshot = journal.snapshot()
    expect(
      usageLimitContinueChain(snapshot.items, snapshot.submissions, { turnItemId: turnItem.itemId })
    ).toBe(1)
  } finally {
    await adapter.closeAll()
    await sink.drained()
    sink.close()
  }
})
