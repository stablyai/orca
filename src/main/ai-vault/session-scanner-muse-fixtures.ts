import type { IncrementalAgentFixture } from './session-scanner-incremental-fixtures'

export function museFixture(): IncrementalAgentFixture {
  const line = (
    payloadType: string,
    payload: unknown,
    recordedAt = 1_777_629_600_000_000
  ): string => JSON.stringify({ payload_type: payloadType, payload, recorded_at: recordedAt })
  const intent = line('runtime.user_intent.accepted', { refill_blocks: [{ text: 'Explain 世界' }] })
  const started = line('runtime.session', { event: { kind: 'started', prompt: 'Explain 世界' } })
  return {
    agent: 'muse',
    fileName: 'muse-session/session.jsonl',
    seedLines: [
      line('runtime.session.metadata', { record: { workspace_root: '/projects/example' } }),
      intent
    ],
    appendLines: [
      started,
      JSON.stringify({
        children: [
          {
            record_json: line('runtime.session', {
              event: { kind: 'assistant_message_committed', text: 'Muse answer' }
            })
          }
        ]
      }),
      line('runtime.session', {
        event: {
          kind: 'model_completed',
          model: 'muse-model',
          usage: { input_tokens: 10, output_tokens: 20 }
        }
      }),
      intent
    ],
    truncatedLines: [line('runtime.session', { event: { kind: 'started', prompt: 'Rewritten' } })]
  }
}
