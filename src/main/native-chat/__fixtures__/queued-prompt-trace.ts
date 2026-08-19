/**
 * A synthetic transcript window around a prompt sent while the agent was
 * mid-turn. Every value here is invented; the shape mirrors what the agent
 * writes — the queue pair, the `queued_command` attachment, and the assistant
 * turns that bracket them.
 *
 * The attachment is placed after the row it follows while carrying the earlier
 * enqueue time, which is the ordering the file-order anchoring exists for.
 */
export const QUEUED_PROMPT_TRACE: readonly string[] = [
  '{"parentUuid":null,"isSidechain":false,"message":{"model":"synthetic-model","id":"msg-0001","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"THINKING_1","signature":"SIGNATURE"}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}},"requestId":"req-0001","type":"assistant","uuid":"a-001","timestamp":"2019-03-04T05:00:00.000Z","sessionId":"sess-0001","version":"2.1.220"}',
  '{"parentUuid":"a-001","isSidechain":false,"message":{"model":"synthetic-model","id":"msg-0001","type":"message","role":"assistant","content":[{"type":"text","text":"ASSISTANT_TEXT_1"}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}},"requestId":"req-0001","type":"assistant","uuid":"a-002","timestamp":"2019-03-04T05:00:01.000Z","sessionId":"sess-0001","version":"2.1.220"}',
  '{"parentUuid":"a-002","isSidechain":false,"message":{"model":"synthetic-model","id":"msg-0001","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tool-001","name":"Bash","input":{"command":"TOOL_COMMAND"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}},"requestId":"req-0001","type":"assistant","uuid":"a-003","timestamp":"2019-03-04T05:00:18.000Z","sessionId":"sess-0001","version":"2.1.220"}',
  '{"type":"queue-operation","operation":"enqueue","timestamp":"2019-03-04T05:00:24.000Z","sessionId":"sess-0001","content":"QUEUED_COMMAND"}',
  '{"type":"queue-operation","operation":"remove","timestamp":"2019-03-04T05:01:17.000Z","sessionId":"sess-0001","content":"QUEUED_COMMAND"}',
  '{"parentUuid":"a-003","isSidechain":false,"promptId":"prompt-0001","type":"user","message":{"role":"user","content":[{"tool_use_id":"tool-001","type":"tool_result","content":"TOOL_RESULT","is_error":false}]},"uuid":"a-004","timestamp":"2019-03-04T05:01:17.000Z","toolUseResult":{"stdout":"TOOL_RESULT","stderr":"","interrupted":false,"isImage":false},"sourceToolAssistantUUID":"asst-0001","sessionId":"sess-0001","version":"2.1.220"}',
  '{"parentUuid":"a-004","isSidechain":false,"type":"attachment","attachment":{"type":"queued_command","prompt":"QUEUED_COMMAND","commandMode":"prompt","origin":{"kind":"human"},"timestamp":"2019-03-04T05:00:24.000Z"},"uuid":"a-005","timestamp":"2019-03-04T05:00:24.000Z","sessionId":"sess-0001","version":"2.1.220"}',
  '{"type":"last-prompt","lastPrompt":"LAST_PROMPT","sessionId":"sess-0001"}',
  '{"type":"ai-title","aiTitle":"AI_TITLE","sessionId":"sess-0001"}',
  '{"type":"mode","mode":"MODE","sessionId":"sess-0001"}',
  '{"type":"permission-mode","permissionMode":"PERMISSION_MODE","sessionId":"sess-0001"}',
  '{"parentUuid":"a-004","isSidechain":false,"message":{"model":"synthetic-model","id":"msg-0001","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"THINKING_2","signature":"SIGNATURE"}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}},"requestId":"req-0001","type":"assistant","uuid":"a-006","timestamp":"2019-03-04T05:01:31.000Z","sessionId":"sess-0001","version":"2.1.220"}',
  '{"parentUuid":"a-006","isSidechain":false,"message":{"model":"synthetic-model","id":"msg-0001","type":"message","role":"assistant","content":[{"type":"text","text":"ASSISTANT_TEXT_2"}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}},"requestId":"req-0001","type":"assistant","uuid":"a-007","timestamp":"2019-03-04T05:01:34.000Z","sessionId":"sess-0001","version":"2.1.220"}'
]

/** Sentinel standing in for the prompt text. */
export const QUEUED_PROMPT_TEXT = 'QUEUED_COMMAND'
