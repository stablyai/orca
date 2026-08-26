import { join } from 'node:path'

import type { IncrementalAgentFixture } from './session-scanner-incremental-fixtures'

export function junieFixture(): IncrementalAgentFixture {
  // Real Junie shapes: events are discriminated by `kind` (not `type`), UI events nest
  // under `event.agentEvent`, and every line carries `timestampMs`.
  const prompt = (text: string, at: number) =>
    JSON.stringify({
      kind: 'UserPromptEvent',
      prompt: text,
      presentablePrompt: text,
      timestampMs: at
    })
  const agentEvent = (event: Record<string, unknown>, at: number) =>
    JSON.stringify({
      kind: 'SessionA2uxEvent',
      event: { state: 'IN_PROGRESS', agentEvent: event },
      timestampMs: at
    })
  return {
    agent: 'junie',
    fileName: join('sessions', 'session-260501-101200-abcd', 'events.jsonl'),
    seedLines: [
      agentEvent(
        { kind: 'CurrentDirectoryUpdatedEvent', currentDirectory: '/repo/app' },
        1_777_000_000_000
      ),
      prompt('junie seed question', 1_777_000_001_000),
      // Terminal snapshots are the bulk of a real transcript and must stay ignored.
      agentEvent({ kind: 'TerminalBlockUpdatedEvent', text: 'noise'.repeat(20) }, 1_777_000_002_000)
    ],
    appendLines: [
      agentEvent(
        {
          kind: 'ResultBlockUpdatedEvent',
          stepId: 'step-1',
          result: 'junie incremental answer'
        },
        1_777_000_003_000
      ),
      // The duplicate COMPLETED emission of the same step must not double-count.
      agentEvent(
        {
          kind: 'ResultBlockUpdatedEvent',
          stepId: 'step-1',
          result: 'junie incremental answer'
        },
        1_777_000_003_500
      ),
      agentEvent(
        {
          kind: 'LlmResponseMetadataEvent',
          modelUsage: [
            {
              model: 'junie-primary',
              inputTokens: 40,
              cacheInputTokens: 5,
              cacheCreateTokens: 0,
              outputTokens: 25
            },
            {
              model: 'junie-helper',
              inputTokens: 10,
              cacheInputTokens: 0,
              cacheCreateTokens: 0,
              outputTokens: 1
            }
          ]
        },
        1_777_000_004_000
      )
    ],
    truncatedLines: [prompt('junie rewritten', 1_777_000_000_000)]
  }
}
