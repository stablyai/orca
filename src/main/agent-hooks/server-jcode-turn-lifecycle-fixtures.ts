// Jcode 0.99.0 capture2 Skunk A/C payloads; the C start has the identical object.
export const TURN_START = {
  cwd: '/tmp/jcapt-cwd',
  event: 'turn_start',
  model: 'claude-opus-5-5',
  session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
  source: 'chat'
}

export const TOOL = {
  cwd: '/tmp/jcapt-cwd',
  duration_ms: '4',
  event: 'post_tool',
  output_bytes: '141',
  session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
  status: 'ok',
  tool_call_id: 'toolu_01TZBbR67P4rUjBmfNMGPpQa',
  tool_input:
    '{"content":"one","file_path":"edit-me.txt","intent":"Create edit-me.txt with text one"}',
  tool_name: 'write',
  touched_paths: '/tmp/jcapt-cwd/edit-me.txt'
}

export const TURN_END = {
  cache_read_tokens: '85906',
  cache_write_tokens: '589',
  cwd: '/tmp/jcapt-cwd',
  duration_ms: '12632',
  event: 'turn_end',
  input_tokens: '616',
  last_assistant_text:
    'I created `edit-me.txt` containing exactly `one`, with no trailing newline.',
  model: 'claude-opus-5-5',
  output_tokens: '138',
  prompt_tokens: '87111',
  session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
  status: 'ok'
}

export const SESSION_END = {
  cwd: '/tmp/jcapt-cwd',
  event: 'session_end',
  model: 'claude-opus-5-5',
  session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
  source: 'close'
}

export const LATE_TOOL = {
  cwd: '/tmp/jcapt-cwd',
  duration_ms: '60002',
  event: 'post_tool',
  output_bytes: '42',
  session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
  status: 'ok',
  tool_call_id: 'toolu_01W9skACGmbdV4ceskfT1b8v',
  tool_input: '{"command":"sleep 60","intent":"Sleep 60 seconds","timeout":90000}',
  tool_name: 'bash',
  touched_paths: ''
}
