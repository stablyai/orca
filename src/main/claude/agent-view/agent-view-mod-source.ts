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
let timerToken = 0
let attemptedAt = 0
let announcing

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

  // One live timer: a newer schedule (or a durable reply) voids the earlier one.
  function schedule($, delay) {
    const token = ++timerToken
    try {
      $.clock.after(delay, () => token === timerToken ? announce($) : undefined)
    } catch {}
  }

  // Undelivered (Orca restarting, quit or unreachable): back off 1 s doubling to 5 min.
  function retry($) {
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 1000, 300000)
    schedule($, retryDelay)
  }

  // One registration in flight; concurrent triggers (parallel turns, renders, timers) share it.
  function announce($) {
    announcing ??= announceNow($).finally(() => { announcing = undefined })
    return announcing
  }

  async function announceNow($) {
    try {
      attemptedAt = await $.clock.now()
      if (!paneKey || !configDir) return {}
      const sessionId = await $.session.id()
      if (sessionId === endedSessionId) return {}
      if (!identity || identity.sessionId !== sessionId) {
        identity = { paneKey, sessionId, instanceId: String(await $.clock.now()) + '-' + String(Math.random()) }
      }
      const session = identity
      // Unreadable (gone or mid-edit) registers no binding; Orca reads the file itself on a click.
      let keybindings = ''
      try { keybindings = await $.fs.read(configDir + '/keybindings.json') } catch {}
      if (identity !== session || endedSessionId === sessionId) return {}
      let result
      try {
        result = await post($, 'register', {
          keybindings,
          configDir,
          ...(observedView?.sessionId === sessionId ? { view: observedView.view } : {})
        }, session)
      } catch {}
      // A relay that could not forward answers {} with neither flag.
      if (!result?.registered && !result?.unbound) {
        await retry($)
        return {}
      }
      retryDelay = 0
      // An older Orca forgets a pane after 15 s of quiet; keep its 5 s heartbeat.
      if (!result.durable) schedule($, 5000)
      else timerToken++
      // A /clear during the post: announce the session that replaced this one.
      if (identity && identity !== session) void announce($)
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
        } else {
          void announce($) // a /clear or resume started a session this mod has not announced
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
        if (paneKey && (!identity || (await $.clock.now()) - attemptedAt >= 30000)) void announce($)
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
    // This mod's session.start does not run again for /clear or resume; announce the next session.
    else schedule($, 1000)
    return result
  })
}
`.trimStart()
