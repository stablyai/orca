import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentSessionWriteNoticeEnglish } from '../../shared/agent-session-refusal-notice'
import { structuredAgentSessionRejectionParts } from '../../shared/structured-agent-session-rejection-words'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'
import { codexTurnEndRejection, readCodexTurnEnd } from './codex-structured-turn-end-settlement'

describe('captured Codex transport diagnostics on a send not echoed before failure', () => {
  it('labels the failed-turn detail for the log and keeps it off the shared notice', () => {
    const frames = readFileSync(
      join(__dirname, '__fixtures__', 'codex-app-server-turn-endings.jsonl'),
      'utf8'
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => readCodexJournalRecord(JSON.parse(line)))
    const frame = frames.find(
      (entry) => entry.case === '0.141.0-conn-refused' && entry.method === 'turn/completed'
    )
    const end = readCodexTurnEnd('turn/completed', frame?.params)
    expect(end).toMatchObject({ status: 'failed', detail: { audience: 'log' } })
    const rejection = end ? codexTurnEndRejection(end) : null
    expect(rejection?.reason).toBe("Codex didn't accept this message.")
    expect(
      agentSessionWriteNoticeEnglish(
        structuredAgentSessionRejectionParts(
          rejection?.reason ?? null,
          'send',
          rejection?.rejection,
          { agentName: 'Codex' }
        )
      )
    ).toBe("Codex didn't accept this message.")
  })
})
