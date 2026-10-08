import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { SavedStructuredSessionEntry } from '../../../shared/structured-agent-session-saved-status'
import {
  restoreSavedStructuredAgentSessionStatuses,
  restoredStructuredSessionSummary
} from './structured-agent-session-saved-status-restore'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

function record(sessionId: string): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })),
    conversationName: 'Named on the record',
    options: { model: 'model-on-the-record' }
  }
}

function saved(
  sessionId: string,
  status: AgentSessionStatusSummary['status'] = 'working',
  fields: Partial<AgentSessionStatusSummary> = {}
): SavedStructuredSessionEntry {
  return {
    sessionId,
    saved: {
      summary: {
        sessionId,
        status,
        latestPrompt: 'refactor the parser',
        updatedAt: 40_000,
        statusStartedAt: 39_000,
        ...fields
      }
    }
  }
}

describe("a settled chat's restored row", () => {
  it("is the journal's half as saved and the record's half from the record", () => {
    const entry = saved('chat', 'idle', { turnOutcome: 'failure' })

    expect(restoredStructuredSessionSummary(entry.saved!, record('chat'))).toEqual({
      ...entry.saved!.summary,
      workspaceId: 'workspace-1',
      agent: 'claude',
      model: 'model-on-the-record',
      conversationName: 'Named on the record',
      providerSession: expect.anything()
    })
  })
})

function restoreInput(
  entries: SavedStructuredSessionEntry[],
  records: AgentSessionRecord[],
  listed: string[],
  owedMail: string[] = [],
  unreadable: string[] = []
) {
  const log = recordingStructuredAgentSessionLogger()
  return {
    log,
    input: {
      listed,
      owedMail,
      saved: entries,
      getRecord: (sessionId: string) =>
        records.find((candidate) => candidate.sessionId === sessionId) ?? null,
      isUnreadable: (sessionId: string) => unreadable.includes(sessionId),
      restoreSaved: vi.fn(),
      dropSaved: vi.fn(),
      settle: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      logger: log.logger
    }
  }
}

describe('restoring saved statuses at startup', () => {
  it('shows each listed settled chat, and opens a cut one without showing what was saved', async () => {
    const { input } = restoreInput(
      [saved('cut'), saved('waiting', 'attention'), saved('idle', 'idle')],
      [record('cut'), record('waiting'), record('idle')],
      ['cut', 'waiting', 'idle']
    )

    await restoreSavedStructuredAgentSessionStatuses(input)

    expect(input.restoreSaved.mock.calls.map(([summary]) => summary.sessionId)).toEqual(['idle'])
    expect(input.settle).toHaveBeenCalledExactlyOnceWith(['cut', 'waiting'])
    expect(input.close).not.toHaveBeenCalled()
    expect(input.dropSaved).not.toHaveBeenCalled()
  })

  it('opens nothing when no chat was cut and no mail waits', async () => {
    const { input } = restoreInput([saved('idle', 'idle')], [record('idle')], ['idle'])

    await restoreSavedStructuredAgentSessionStatuses(input)

    expect(input.settle).not.toHaveBeenCalled()
  })

  it('also opens each listed chat parked mail waits on, once, and no unlisted one', async () => {
    const { input } = restoreInput(
      [saved('cut'), saved('mailed', 'idle')],
      [record('cut'), record('mailed'), record('unsaved'), record('closed')],
      ['cut', 'mailed', 'unsaved'],
      ['mailed', 'cut', 'unsaved', 'closed', 'gone']
    )

    await restoreSavedStructuredAgentSessionStatuses(input)

    expect(input.settle).toHaveBeenCalledExactlyOnceWith(['cut', 'mailed', 'unsaved'])
    expect(input.close).not.toHaveBeenCalled()
  })

  it('settles an unlisted cut chat, then closes it and lets its saved status die', async () => {
    const { input } = restoreInput([saved('worker')], [record('worker')], [])

    await restoreSavedStructuredAgentSessionStatuses(input)

    expect(input.restoreSaved).not.toHaveBeenCalled()
    expect(input.settle).toHaveBeenCalledExactlyOnceWith(['worker'])
    expect(input.close).toHaveBeenCalledExactlyOnceWith('worker')
    expect(input.dropSaved).toHaveBeenCalledExactlyOnceWith('worker')
    expect(input.settle.mock.invocationCallOrder[0]).toBeLessThan(
      input.close.mock.invocationCallOrder[0]!
    )
  })

  it('drops a saved status nothing lists or whose chat is gone', async () => {
    const { input } = restoreInput(
      [saved('closed', 'idle'), saved('gone')],
      [record('closed')],
      ['gone']
    )

    await restoreSavedStructuredAgentSessionStatuses(input)

    expect(input.dropSaved.mock.calls).toEqual([['closed'], ['gone']])
    expect(input.restoreSaved).not.toHaveBeenCalled()
    expect(input.settle).not.toHaveBeenCalled()
  })

  it("keeps a newer build's entries: one it cannot parse, and one for a record it cannot read", async () => {
    const { input } = restoreInput(
      [{ sessionId: 'unparsed', saved: null }, saved('newer-record')],
      [record('unparsed')],
      ['unparsed', 'newer-record'],
      [],
      ['newer-record']
    )

    await restoreSavedStructuredAgentSessionStatuses(input)

    expect(input.dropSaved).not.toHaveBeenCalled()
    expect(input.restoreSaved).not.toHaveBeenCalled()
    expect(input.settle).not.toHaveBeenCalled()
  })

  it('logs a failed settle and close, and still settles the rest of the startup', async () => {
    const { input, log } = restoreInput(
      [saved('cut'), saved('worker'), saved('idle', 'idle')],
      [record('cut'), record('worker'), record('idle')],
      ['cut', 'idle']
    )
    input.settle.mockRejectedValueOnce(new Error('disk I/O error'))
    input.close.mockRejectedValueOnce(new Error('disk I/O error'))

    await expect(restoreSavedStructuredAgentSessionStatuses(input)).resolves.toBeUndefined()

    expect(input.restoreSaved).toHaveBeenCalledOnce()
    expect(input.dropSaved).toHaveBeenCalledExactlyOnceWith('worker')
    expect(log.entries.map((entry) => entry.fields.scope)).toEqual([
      'saved-status-settle',
      'saved-status-close'
    ])
  })
})
