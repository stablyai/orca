// Scripted ACP peer: tests protocol controls without the official CLI or a model provider.
export const DSH_ACP_PEER = String.raw`
const readline = require('node:readline')
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
let model = 'fixture-model', effort = 'fixture-calm', prompt = null
const sessionId = 'fixture-session'
const configOptions = () => [
  { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: model,
    options: [{ group: 'fixture', name: 'Fixture provider', options: [
      { value: 'fixture-model', name: 'Fixture model' }, { value: 'fixture-alternative', name: 'Alternative' }
    ] }] },
  { id: 'reasoning_effort', category: 'thought_level', name: 'Thinking', type: 'select', currentValue: effort,
    options: [{ value: 'fixture-calm', name: 'Calm' }, { value: 'fixture-deep', name: 'Deep' }] }
]
const update = value => send({ method: 'session/update', params: { sessionId, update: value } })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  const reply = result => send({ id: frame.id, result })
  if (frame.method === 'initialize') return reply({ protocolVersion: 1,
    agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
    agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } } })
  if (frame.method === 'session/new') return reply({ sessionId, configOptions: configOptions() })
  if (frame.method === 'session/resume') return reply({ configOptions: configOptions() })
  if (frame.method === 'session/list') return reply({ sessions: [{ sessionId, cwd: process.cwd() }] })
  if (frame.method === 'session/set_config_option') {
    if (frame.params.configId === 'model') model = frame.params.value
    if (frame.params.configId === 'reasoning_effort') effort = frame.params.value
    return reply({ configOptions: configOptions() })
  }
  if (frame.method === 'session/close') return reply({})
  if (frame.method === 'test/cwd') return reply({ cwd: process.cwd(), dshHome: process.env.DSH_HOME })
  if (frame.method === 'test/malformed') return process.stdout.write('console banner\n')
  if (frame.method === 'test/oversized') return process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\n')
  if (frame.method === 'test/wrong-session') return send({ method: 'session/update', params: {
    sessionId: 'another-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign' } } } })
  if (frame.method === 'session/prompt') {
    prompt = frame
    if (frame.params.prompt[0].text === 'refuse') return send({ id: frame.id, error: { code: -32000, message: 'fixture refused' } })
    if (frame.params.prompt[0].text === 'hold') return
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Synthetic thought' } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture' } })
    update({ sessionUpdate: 'tool_call', toolCallId: 'fixture-tool', title: 'Fixture tool', status: 'pending', rawInput: { path: 'owned' } })
    return send({ id: 700, method: 'session/request_permission', params: { sessionId,
      toolCall: { toolCallId: 'fixture-tool', title: 'Approve fixture tool' },
      options: [{ optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-1', name: 'Reject once', kind: 'reject_once' }] } })
  }
  if (frame.id === 700 && frame.result) {
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'fixture-tool', status: 'completed', rawOutput: { permission: frame.result } })
    update({ sessionUpdate: 'usage_update', used: 12, size: 100 })
    if (prompt) { send({ id: prompt.id, result: { stopReason: 'end_turn' } }); prompt = null }
  }
  if (frame.method === 'session/cancel' && prompt) {
    send({ id: prompt.id, result: { stopReason: 'cancelled' } }); prompt = null
  }
})
`
