import { CLAUDE_AGENT_VIEW_PATH } from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'
import { parseAgentHookEndpointFile } from '../../../shared/agent-hook-listener/transport/agent-hook-endpoint-file'

export const CLAUDE_AGENT_VIEW_MOD_SOURCE = String.raw`
const parseEndpoint = ${parseAgentHookEndpointFile.toString()}

let identity
let configDir
let paneKey
let endedSessionId
let observedView
let viewRevision = 0
let retryDelay = 0
let retryStartedAt = 0
let timerQueued = false
let announcedAt = 0

  async function post($, action, data = {}, session = identity) {
    if (!session) return {}
    let port = await $.env.get('ORCA_AGENT_HOOK_PORT')
    let token = await $.env.get('ORCA_AGENT_HOOK_TOKEN')
    const endpoint = await $.env.get('ORCA_AGENT_HOOK_ENDPOINT')
    if (endpoint) {
      try {
        const file = parseEndpoint(await $.fs.read(endpoint))
        port = file.port
        token = file.token
      } catch {}
    }
    if (!token || !/^[0-9]+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) return undefined
    const response = await $.http.fetch('http://127.0.0.1:' + port + ${JSON.stringify(CLAUDE_AGENT_VIEW_PATH)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orca-agent-hook-token': token },
      body: JSON.stringify({ ...session, action, ...data })
    })
    // 204 (Orca not current, or a relay that could not forward) is not delivered.
    if (!response.ok || !response.text) return undefined
    try {
      const data = JSON.parse(response.text)
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    } catch { return {} }
  }

  function schedule($, delay) {
    if (timerQueued) return
    timerQueued = true
    try {
      $.clock.after(delay, () => { timerQueued = false; return announce($) })
    } catch { timerQueued = false }
  }

  // Undelivered: back off 1 s doubling to 60 s, for up to an hour (an Orca restart or quit).
  async function retry($) {
    const now = await $.clock.now()
    if (!retryDelay) retryStartedAt = now
    if (now - retryStartedAt > 3600000) {
      retryDelay = 0 // the next failure opens a new window
      return
    }
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 1000, 60000)
    schedule($, retryDelay)
  }

  async function announce($) {
    try {
      if (!paneKey || !configDir) return {}
      const sessionId = await $.session.id()
      if (sessionId === endedSessionId) return {}
      if (!identity || identity.sessionId !== sessionId) {
        identity = { paneKey, sessionId, instanceId: String(await $.clock.now()) + '-' + String(Math.random()) }
      }
      const session = identity
      let keybindings
      try {
        keybindings = await $.fs.read(configDir + '/keybindings.json')
      } catch {
        // Gone or mid-edit: Orca drops the pane now, and the read is retried with backoff.
        if (!retryDelay) try { await post($, 'end') } catch {}
        await retry($)
        return {}
      }
      if (identity !== session || endedSessionId === sessionId) return {}
      let result
      try {
        result = await post($, 'register', {
          keybindings,
          configDir,
          ...(observedView?.sessionId === sessionId ? { view: observedView.view } : {})
        }, session)
      } catch {}
      // A relay that could not forward answers {} with no registered.
      if (!result?.registered) {
        await retry($)
        return {}
      }
      retryDelay = 0
      announcedAt = await $.clock.now()
      // An older Orca forgets a pane after 15 s of quiet; keep its 5 s heartbeat.
      if (!result.durable) schedule($, 5000)
      return result
    } catch {
      return {}
    }
  }

export function register(on) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    if (!paneKey) return next(event)
    const result = await next(event)
    if (event.surface === 'terminal' && event.props.view) {
      const sessionId = await $.session.id()
      const agentId = event.props.view.agentId
      if (observedView?.sessionId !== sessionId || observedView.view.agentId !== agentId) {
        observedView = { sessionId, view: { ...(agentId ? { agentId } : {}), revision: ++viewRevision } }
        if (identity?.sessionId === sessionId) {
          void post($, 'observe', { view: observedView.view }).then(
            (reply) => { if (!reply?.observed) void announce($) },
            () => { void announce($) }
          )
        }
      }
    }
    return result
  })

  on('session.start', async ($, event, next) => {
    const result = await next(event)
    const targetPane = await $.env.get('ORCA_PANE_KEY')
    if (!event.isInteractive || event.surface !== 'terminal' || !targetPane) return result
    paneKey = targetPane
    configDir = await $.env.get('CLAUDE_CONFIG_DIR') || await $.env.get('ORCA_CLAUDE_CONFIG_DIR')
    if (!configDir) return result
    endedSessionId = undefined
    await $.command.register({ name: 'orca-agent-view', description: 'Open the agent selected in Orca', immediate: true })
    void announce($)
    return result
  })

  // Re-announces after Orca dropped the pane (or missed a post); at most one post per 30 s of turns.
  try {
    on('turn.start', async ($, event, next) => {
      const result = await next(event)
      try {
        if (identity && (await $.clock.now()) - announcedAt >= 30000) void announce($)
      } catch {}
      return result
    })
  } catch {}

  on('command.run', { command: 'orca-agent-view' }, async ($) => {
    try {
      const session = identity
      if (!session || session.sessionId !== await $.session.id()) return {}
      const request = await post($, 'take', {}, session)
      if (!request || request.unknown) {
        void announce($)
        return {}
      }
      if (!request.requestId || request.expiresAt < await $.clock.now()) return {}
      if (identity !== session || session.sessionId !== await $.session.id()) return {}
      let deny
      try {
        const result = await $.ui.view(request.agentId ? { agentId: request.agentId } : {})
        deny = result.deny
      } catch { deny = 'Claude could not switch the agent view' }
      await post($, 'ack', { requestId: request.requestId, ...(deny ? { deny } : {}) }, session)
    } catch {}
    return {}
  })

  on('session.end', async ($, event, next) => {
    const session = identity
    const result = await next(event)
    void post($, 'end', {}, session).catch(() => {})
    endedSessionId = event.sessionId
    identity = undefined
    if (event.reason !== 'clear' && event.reason !== 'resume') paneKey = undefined
    return result
  })
}
`.trimStart()
