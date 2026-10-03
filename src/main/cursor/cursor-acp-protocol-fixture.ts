// Protocol fixture: actual supervised subprocess/stdio, with no model or account access.
export const ACP_FIXTURE = String.raw`
const readline = require('node:readline')
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const update = (sessionId, text) => send({ method: 'session/update', params: {
  sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}})
let pending
let approvedPrompt
let permissionPending = false
let cancelled = false
const control = (value) => {
  if (process.env.CURSOR_ACP_FIXTURE_CONTROL_LOG) require('node:fs').appendFileSync(process.env.CURSOR_ACP_FIXTURE_CONTROL_LOG, JSON.stringify(value) + '\n')
}
if (process.env.CURSOR_ACP_FIXTURE_CONTROL_LOG) {
  const home = process.env.ORCA_E2E_HOME_DIR
  if (!home || process.env.HOME !== home || process.env.USERPROFILE !== home || process.env.CURSOR_CONFIG_DIR !== require('node:path').join(home, '.cursor') || process.env.ORCA_BACKGROUND_LAUNCH !== '1' || process.env.ORCA_DISABLE_CODEX_TRUST_RPC !== '1') throw new Error('Fixture child escaped private background launch policy')
  control({ method: 'fixture/bootstrap', homeIsolated: true })
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line)
  if (process.env.CURSOR_ACP_FIXTURE_LOG && ['session/new', 'session/load'].includes(frame.method)) {
    require('node:fs').appendFileSync(process.env.CURSOR_ACP_FIXTURE_LOG, JSON.stringify({ method: frame.method, sessionId: frame.params.sessionId ?? 'fixture-conversation-1' }) + '\n')
  }
  if (frame.jsonrpc !== '2.0') return process.exit(3)
  if (frame.method === 'initialized') return process.exit(4)
  if (frame.method === 'initialize') return send({ id: frame.id, result: {
    protocolVersion: process.env.FIXTURE_BAD_VERSION ? 2 : 1,
    agentCapabilities: { loadSession: !process.env.FIXTURE_NO_LOAD }
  }})
  if (frame.method === 'session/new') {
    if (process.env.FIXTURE_AUTH) return send({ id: frame.id, error: {
      code: -32000, message: 'Authentication required'
    }})
    return send({ id: frame.id, result: { sessionId: 'fixture-conversation-1', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'fixture-model', options: [{ value: 'fixture-model', name: 'Fixture model' }, { value: 'fixture-model-2', name: 'Fixture model two' }] }] }})
  }
  if (frame.method === 'session/set_config_option') return send({ id: frame.id, result: { configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: frame.params.value, options: [{ value: 'fixture-model', name: 'Fixture model' }, { value: 'fixture-model-2', name: 'Fixture model two' }] }] } })
  if (frame.method === 'session/load') {
    update(frame.params.sessionId, 'fixture replay')
    return send({ id: frame.id, result: { configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'fixture-model', options: [{ value: 'fixture-model', name: 'Fixture model' }, { value: 'fixture-model-2', name: 'Fixture model two' }] }] } })
  }
  if (frame.method === 'session/prompt') {
    pending = frame
    cancelled = false
    const text = frame.params.prompt[0].text
    if (text === 'cancel') return update(frame.params.sessionId, 'fixture running')
    if (text === 'approval') {
      approvedPrompt = frame
      permissionPending = true
      send({ method: 'session/update', params: { sessionId: frame.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Fixture tool', status: 'pending' } } })
      return send({ id: 'permission-1', method: 'session/request_permission', params: {
        sessionId: frame.params.sessionId, toolCall: { toolCallId: 'tool-1', title: 'Fixture tool' },
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]
      }})
    }
    if (text === 'wrong-session') update('foreign-session', 'must be rejected')
    else update(frame.params.sessionId, text)
    return send({ id: frame.id, result: { stopReason: 'end_turn' } })
  }
  if (frame.method === 'session/cancel') {
    cancelled = true
    control({ method: 'session/cancel' })
    if (process.env.FIXTURE_IGNORE_CANCEL || permissionPending) return
    return send({ id: pending.id, result: { stopReason: 'cancelled' } })
  }
  if (frame.id === 'permission-1') {
    if (!permissionPending) return process.exit(5)
    permissionPending = false
    const outcome = frame.result?.outcome?.outcome
    control({ method: 'permission/response', outcome })
    if (outcome === 'cancelled' && cancelled) {
      if (process.env.FIXTURE_IGNORE_CANCEL) return
      return send({ id: approvedPrompt.id, result: { stopReason: 'cancelled' } })
    }
    send({ method: 'session/update', params: { sessionId: approvedPrompt.params.sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' }
    }})
    return send({ id: approvedPrompt.id, result: { stopReason: 'end_turn' } })
  }
})
`

export function cursorAcpFixtureLaunch(env: Record<string, string> = {}) {
  return { command: process.execPath, args: ['-e', ACP_FIXTURE], env }
}
