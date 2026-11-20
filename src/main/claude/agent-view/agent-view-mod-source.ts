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
let lastAnnouncement
let supportsRenew = false
let refreshTimer
let refreshMs
let announcing
let announceAgain = false

  async function connection($) {
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
    return { port, token }
  }

  async function post($, action, data = {}, session = identity, target) {
    if (!session) return {}
    const { port, token } = target || await connection($)
    if (!token || !/^[0-9]+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) return {}
    const response = await $.http.fetch('http://127.0.0.1:' + port + ${JSON.stringify(CLAUDE_AGENT_VIEW_PATH)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orca-agent-hook-token': token },
      body: JSON.stringify({ ...session, action, ...data })
    })
    if (!response.ok || !response.text) return {}
    try {
      const data = JSON.parse(response.text)
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    } catch { return {} }
  }

  function refresh($, ms) {
    if (refreshMs === ms) return
    refreshTimer?.cancel()
    refreshMs = ms
    refreshTimer = $.clock.every(ms, () => announce($))
  }

  async function sendAnnouncement($) {
    try {
      if (!paneKey || !configDir) return {}
      const sessionId = await $.session.id()
      if (sessionId === endedSessionId) return {}
      if (!identity || identity.sessionId !== sessionId) {
        identity = { paneKey, sessionId, instanceId: String(await $.clock.now()) + '-' + String(Math.random()) }
        lastAnnouncement = undefined
        supportsRenew = false
      }
      const session = identity
      const keybindings = await $.fs.read(configDir + '/keybindings.json').catch(() => '')
      const target = await connection($)
      if (identity !== session || endedSessionId === sessionId) return {}
      const data = {
        keybindings,
        ...(observedView?.sessionId === sessionId ? { view: observedView.view } : {})
      }
      const announcement = JSON.stringify({ ...target, keybindings })
      if (supportsRenew && lastAnnouncement === announcement) {
        const reply = await post($, 'renew', observedView?.sessionId === sessionId ? { view: observedView.view } : {}, session, target)
        if (reply.registered || identity !== session || endedSessionId === sessionId) return reply
      }
      // Until this endpoint confirms renewal support, keep the legacy lease alive.
      refresh($, 5000)
      supportsRenew = false
      const reply = await post($, 'register', data, session, target)
      if (identity !== session || endedSessionId === sessionId) return {}
      supportsRenew = reply.renew === true
      if (reply.registered) lastAnnouncement = announcement
      // Older runtimes still expire registrations after 15 seconds.
      refresh($, supportsRenew ? 60000 : 5000)
      return reply
    } catch {
      return {}
    }
  }

  function announce($) {
    announceAgain = true
    if (!announcing) {
      announcing = (async () => {
        while (announceAgain) {
          announceAgain = false
          await sendAnnouncement($)
        }
      })().finally(() => { announcing = undefined })
    }
    return announcing
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
          const session = identity
          const view = observedView.view
          void (async () => {
            await announcing
            if (identity === session && endedSessionId !== sessionId) {
              await post($, 'observe', { view }, session)
            }
          })().catch(() => {})
        } else {
          void announce($)
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
    refresh($, 5000)
    void announce($)
    return result
  })

  on('command.run', { command: 'orca-agent-view' }, async ($) => {
    try {
      const session = identity
      if (!session || session.sessionId !== await $.session.id()) return {}
      const request = await post($, 'take', {}, session)
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
    lastAnnouncement = undefined
    if (event.reason !== 'clear' && event.reason !== 'resume') {
      paneKey = undefined
      refreshTimer?.cancel()
      refreshTimer = undefined
      refreshMs = undefined
    }
    return result
  })
}
`.trimStart()
