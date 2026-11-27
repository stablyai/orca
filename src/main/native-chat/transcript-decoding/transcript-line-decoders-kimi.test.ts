import { describe, expect, it } from 'vitest'
import { decodeKimiWireLine } from './transcript-line-decoders-kimi'

// Records as Kimi Code 2.7.2 writes them to agents/main/wire.jsonl (long texts shortened).
const WIRE = [
  '{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"Third with thinking"}],"origin":{"kind":"user"},"promptId":"msg_01M8D7MH6RFG4NB465810XAKQH","turnId":0,"trigger":"normal","time":1795740550363}',
  '{"type":"context.append_message","agentId":"main","message":{"role":"user","content":[{"type":"text","text":"Third with thinking"}],"toolCalls":[],"id":"msg_01M8D7MH6RFG4NB465810XAKQH","origin":{"kind":"user"}},"time":1795740550363}',
  '{"type":"context.append_message","agentId":"main","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>\\nAuto permission mode is active.</system-reminder>"}],"toolCalls":[],"origin":{"kind":"injection","variant":"permission_mode"}},"time":1795740550371}',
  '{"type":"context.append_loop_event","agentId":"main","event":{"type":"step.begin","uuid":"61788c71-a4e0-4375-9ff0-37c9390fec63","turnId":"0","step":1},"time":1795740550380}',
  '{"type":"context.append_loop_event","agentId":"main","event":{"type":"content.part","uuid":"05c745b1-a165-49af-bb32-6d434e9bd30b","turnId":"0","step":1,"stepUuid":"61788c71-a4e0-4375-9ff0-37c9390fec63","block":0,"part":{"type":"think","think":"pondering secretly","reasoningKey":"reasoning_content"},"startedAt":1795740550389,"durationMs":0},"time":1795740550390}',
  '{"type":"context.append_loop_event","agentId":"main","event":{"type":"content.part","uuid":"e03b5a7d-0b95-45d0-b062-ed4484f3e988","turnId":"0","step":1,"stepUuid":"61788c71-a4e0-4375-9ff0-37c9390fec63","block":1,"part":{"type":"text","text":"ECHO[1]: Third with thinking"},"startedAt":1795740550389,"durationMs":0},"time":1795740550390}',
  '{"type":"turn.ended","agentId":"main","turnId":0,"reason":"completed","durationMs":24,"time":1795740550392}',
  '{"type":"context.append_message","agentId":"main","message":{"role":"user","content":[{"type":"image_url","imageUrl":{"url":"data:image/png;base64,iVBORw0KGgo="}}],"toolCalls":[],"id":"msg_01M8D9IMAGEONLYPROMPT000000","origin":{"kind":"user"}},"time":1795740560000}'
]

describe('decodeKimiWireLine', () => {
  it('keeps the person’s messages, pasted images and reply text under Kimi’s own ids', () => {
    expect(WIRE.map(decodeKimiWireLine).filter(Boolean)).toEqual([
      {
        recordId: 'msg_01M8D7MH6RFG4NB465810XAKQH',
        message: {
          id: 'msg_01M8D7MH6RFG4NB465810XAKQH',
          role: 'user',
          blocks: [{ type: 'text', text: 'Third with thinking' }],
          timestamp: 1795740550363,
          source: 'transcript'
        }
      },
      {
        recordId: 'e03b5a7d-0b95-45d0-b062-ed4484f3e988',
        message: {
          id: 'e03b5a7d-0b95-45d0-b062-ed4484f3e988',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'ECHO[1]: Third with thinking' }],
          timestamp: 1795740550390,
          source: 'transcript'
        }
      },
      {
        recordId: 'msg_01M8D9IMAGEONLYPROMPT000000',
        message: {
          id: 'msg_01M8D9IMAGEONLYPROMPT000000',
          role: 'user',
          blocks: [{ type: 'text', text: '[image]' }],
          timestamp: 1795740560000,
          source: 'transcript'
        }
      }
    ])
  })
})
