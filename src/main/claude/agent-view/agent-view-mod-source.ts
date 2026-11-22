import {
  CLAUDE_AGENT_VIEW_PATH,
  CLAUDE_TERMINAL_MAIL_PATH
} from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'
import { parseAgentHookEndpointFile } from '../../../shared/agent-hook-listener/transport/agent-hook-endpoint-file'

export const CLAUDE_AGENT_VIEW_MOD_SOURCE = String.raw`
const parseEndpoint = ${parseAgentHookEndpointFile.toString()}

let identity
let configDir
let paneKey
let endedSessionId
let observedView
let viewRevision = 0
let mailIdentity
let mailPoll
let mailTimerStarted = false
let retryDelay = 0
let timerToken = 0
let attemptedAt = 0
let announcing
let announceAgain = false

  async function post($, action, data = {}, session = identity, path = ${JSON.stringify(CLAUDE_AGENT_VIEW_PATH)}) {
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
    const response = await $.http.fetch('http://127.0.0.1:' + port + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orca-agent-hook-token': token },
      body: JSON.stringify({ ...session, action, ...data })
    })
    // 204 (Orca not current) is not delivered.
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

  // Undelivered (Orca restarting, quit or unreachable): back off 1 s doubling to 60 s, so a
  // returning Orca hears a missed view change within a minute.
  function retry($) {
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 1000, 60000)
    schedule($, retryDelay)
  }

  // One registration in flight. A trigger during it (a view change it may have missed) queues one
  // follow-up, so concurrent turns coalesce but no change is lost.
  function announce($) {
    if (announcing) {
      announceAgain = true
      return announcing
    }
    announcing = announceNow($).finally(() => {
      announcing = undefined
      if (announceAgain) {
        announceAgain = false
        void announce($)
      }
    })
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
      if (!result) {
        await retry($)
        return {}
      }
      // Delivered but not taken ({}: Orca not ready for this pane yet, an older Orca without a
      // binding, a relay that could not forward): keep the 5 s check-in.
      if (!result.registered && !result.unbound) {
        retryDelay = 0
        schedule($, 5000)
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

  // Orchestration mail arrives as a turn of its own: nothing is typed into the terminal.
  function pollMail($) {
    if (mailPoll || !paneKey) return mailPoll
    mailPoll = pollMailOnce($).finally(() => { mailPoll = undefined })
    return mailPoll
  }

  async function pollMailOnce($) {
    try {
      const sessionId = await $.session.id()
      if (sessionId === endedSessionId) return
      if (!mailIdentity || mailIdentity.sessionId !== sessionId) {
        mailIdentity = { paneKey, sessionId, instanceId: String(await $.clock.now()) + '-' + String(Math.random()) }
      }
      const session = mailIdentity
      const reply = await post($, 'poll', {}, session, ${JSON.stringify(CLAUDE_TERMINAL_MAIL_PATH)})
      for (const item of reply && Array.isArray(reply.submissions) ? reply.submissions : []) {
        let submitted = false
        // A /clear or resume during an await starts another session; its mail is not this one's.
        let current = false
        try {
          current = mailIdentity === session && (await $.session.id()) === session.sessionId
        } catch {}
        try {
          if (current) {
            const result = await $.prompt.submit({ text: String(item.text) })
            submitted = !result || !result.drop
          }
        } catch {}
        await post($, 'ack', { id: String(item.id), submitted }, session, ${JSON.stringify(CLAUDE_TERMINAL_MAIL_PATH)})
      }
    } catch {}
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
    if (!mailTimerStarted) {
      mailTimerStarted = true
      $.clock.every(1000, () => pollMail($))
    }
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
    // After the poll in flight has acked what it took: an end first would leave those unverifiable.
    const mailSession = mailIdentity
    mailIdentity = undefined
    void Promise.resolve(mailPoll)
      .then(() => post($, 'end', {}, mailSession, ${JSON.stringify(CLAUDE_TERMINAL_MAIL_PATH)}))
      .catch(() => {})
    endedSessionId = event.sessionId
    identity = undefined
    if (event.reason !== 'clear' && event.reason !== 'resume') paneKey = undefined
    // This mod's session.start does not run again for /clear or resume; announce the next session.
    else schedule($, 1000)
    return result
  })
}
`.trimStart()
